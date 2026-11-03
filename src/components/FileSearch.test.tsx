// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FileSearch } from './FileSearch';
import type { NavigationBatch, SourceLocation } from '../contracts';

const file = { path: '/project/run.go', relativePath: 'run.go', size: 20 };
const symbol: SourceLocation = {
  path: '/project/server.go',
  name: 'RunServer',
  range: { start: { line: 8, character: 5 }, end: { line: 8, character: 14 } },
  preview: 'func RunServer() {}',
  contextIds: ['go'],
  relationship: 'workspace symbol',
};
function batch(locations = [symbol]): NavigationBatch {
  return {
    id: 'symbols',
    documentRevision: 0,
    workspaceGeneration: 1,
    state: 'complete',
    searchedContexts: 1,
    totalContexts: 1,
    reasons: [],
    locations,
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
async function search(query: string) {
  fireEvent.change(screen.getByRole('combobox'), { target: { value: query } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
}
it('searches files, functions and package declarations together and opens the exact symbol range', async () => {
  const onOpen = vi.fn();
  const onSearch = vi.fn(async () =>
    batch([symbol, { ...symbol, name: 'runner', relationship: 'package' }]),
  );
  render(
    <FileSearch
      files={[file]}
      recent={[]}
      onOpen={onOpen}
      onClose={() => {}}
      onSearch={onSearch}
    />,
  );
  await search('run');
  const options = screen.getAllByRole('option');
  expect(options).toHaveLength(3);
  expect(within(options[0]).getByText('run.go', { selector: 'strong' })).toBeTruthy();
  expect(within(options[1]).getByText('RunServer')).toBeTruthy();
  expect(within(options[2]).getByText('runner')).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  expect(onOpen).toHaveBeenCalledWith(symbol.path, symbol.range.start, 'go', symbol.range.end);
});
it('retains file results while reporting incomplete symbol coverage and provider failures', async () => {
  const onSearch = vi.fn(async () => ({
    ...batch([]),
    state: 'partial' as const,
    reasons: ['Go is still indexing.'],
    searchedContexts: 0,
  }));
  render(
    <FileSearch
      files={[file]}
      recent={[]}
      onOpen={() => {}}
      onClose={() => {}}
      onSearch={onSearch}
    />,
  );
  await search('run');
  expect(screen.getAllByRole('option')).toHaveLength(1);
  expect(screen.getByText('Go is still indexing.')).toBeTruthy();
  expect(screen.getByText(/partial.*0\/1 contexts/)).toBeTruthy();
  onSearch.mockRejectedValueOnce(new Error('Provider disconnected'));
  await search('missing');
  expect(screen.getByRole('alert').textContent).toContain('Provider disconnected');
  expect(screen.queryByText('No matching symbols.')).toBeNull();
});
it('cancels old queries and never opens their stale symbol results', async () => {
  let finish!: (value: NavigationBatch) => void;
  const onSearch = vi.fn(
    (_query: string, _signal: AbortSignal): Promise<NavigationBatch> =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <FileSearch files={[]} recent={[]} onOpen={() => {}} onClose={() => {}} onSearch={onSearch} />,
  );
  await search('run');
  const oldSignal = onSearch.mock.calls[0][1];
  const oldFinish = finish;
  await search('other');
  expect(oldSignal.aborted).toBe(true);
  await act(async () => oldFinish(batch()));
  expect(screen.queryByRole('option', { name: /RunServer/ })).toBeNull();
});
it('keeps file-only search and recent files available without a symbol provider', () => {
  const onOpen = vi.fn();
  render(<FileSearch files={[file]} recent={[file.path]} onOpen={onOpen} onClose={() => {}} />);
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  expect(onOpen).toHaveBeenCalledWith(file.path);
});
it('finds settings and commands and closes search before running the selected action', async () => {
  const onClose = vi.fn();
  const run = vi.fn(() => expect(onClose).toHaveBeenCalledOnce());
  render(
    <FileSearch
      files={[]}
      recent={[]}
      onOpen={() => {}}
      onClose={onClose}
      commands={[
        { id: 'settings', label: 'Settings: shortcuts and appearance', run },
        { id: 'save', label: 'Save file', disabled: true, run: vi.fn() },
      ]}
    />,
  );
  await search('settings appearance');
  expect(screen.getAllByRole('option')).toHaveLength(1);
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  expect(run).toHaveBeenCalledOnce();
  await search('save');
  expect(screen.queryByRole('option')).toBeNull();
});
it('keeps command selection stable when asynchronous symbol results arrive', async () => {
  let finish!: (value: NavigationBatch) => void;
  const run = vi.fn();
  render(
    <FileSearch
      files={[file]}
      recent={[]}
      onOpen={() => {}}
      onClose={() => {}}
      commands={[{ id: 'run', label: 'Run a workspace command', run }]}
      onSearch={() =>
        new Promise((resolve) => {
          finish = resolve;
        })
      }
    />,
  );
  await search('run');
  expect(screen.getAllByRole('option')[0].textContent).toContain('Run a workspace command');
  await act(async () => finish(batch()));
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  expect(run).toHaveBeenCalledOnce();
});
