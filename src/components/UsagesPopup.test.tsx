// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { NavigationBatch, SourceLocation } from '../contracts';
import { UsagesPopup } from './UsagesPopup';

vi.mock('../api', () => ({ request: async () => null }));
afterEach(cleanup);

const usage = (path: string, line: number, preview: string): SourceLocation => ({
  path,
  range: { start: { line, character: 4 }, end: { line, character: 7 } },
  name: 'Run',
  preview,
  contextIds: ['ctx'],
  relationship: 'reference',
});
const batch = (state: NavigationBatch['state']): NavigationBatch => ({
  id: 'q',
  documentRevision: 1,
  workspaceGeneration: 1,
  state,
  locations: [usage('pkg/a.go', 9, '    s.Run()'), usage('pkg/b.go', 2, 'go Run()')],
  searchedContexts: 1,
  totalContexts: 2,
  reasons: [],
});

function show(state: NavigationBatch['state'] = 'complete') {
  const handlers = { onOpen: vi.fn(), onDock: vi.fn(), onClose: vi.fn() };
  render(
    <UsagesPopup
      anchor={{ left: 40, top: 100, bottom: 118 }}
      symbol="Run"
      batch={batch(state)}
      loading={false}
      {...handlers}
    />,
  );
  return handlers;
}

describe('usages popup', () => {
  it('sits below the caret line and lists usages with syntax-colored code', async () => {
    show();
    const popup = screen.getByRole('dialog', { name: 'Usages of Run' });
    expect(popup.style.top).toBe('124px');
    expect(screen.getByText('a.go:10')).toBeTruthy();
    expect(screen.getByText('2 usages', { exact: false })).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText('Run')[1].className).toBe('tok-function-call'));
  });
  it('opens the highlighted usage with the keyboard and closes on Escape', () => {
    const { onOpen, onClose } = show();
    const list = screen.getByRole('listbox', { name: 'Usages' });
    expect(document.activeElement).toBe(list);
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onOpen.mock.calls[0][0].path).toBe('pkg/b.go');
    fireEvent.keyDown(list, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
  it('docks to the bottom panel and reports incomplete coverage', () => {
    const { onDock } = show('partial');
    expect(screen.getByText('partial')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dock to bottom panel' }));
    expect(onDock).toHaveBeenCalled();
  });
});
