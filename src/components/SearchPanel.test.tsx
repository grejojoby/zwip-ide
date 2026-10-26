// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { SearchPanel } from './SearchPanel';

afterEach(cleanup);
const matches = [
  { path: '/project/src/main.ts', line: 4, text: '  const value = find(value);' },
  { path: '/project/src/main.ts', line: 9, text: 'find(find(value));' },
  { path: '/project/test/main.ts', line: 1, text: 'expect(find(value));' },
];
function show(overrides: Partial<Parameters<typeof SearchPanel>[0]> = {}) {
  const props = {
    query: 'find',
    resultQuery: 'find',
    matches,
    searching: false,
    error: '',
    workspaceRoot: '/project',
    onQueryChange: vi.fn(),
    onSearch: vi.fn(),
    onOpen: vi.fn(),
    ...overrides,
  };
  return { ...render(<SearchPanel {...props} />), props };
}

it('groups matching lines by file with relative directories and literal highlights', () => {
  const { container } = show();
  expect(screen.getByText('3 matching lines in 2 files')).toBeTruthy();
  expect(screen.getByText('src')).toBeTruthy();
  expect(screen.getByText('test')).toBeTruthy();
  expect(screen.queryByText('/project/src')).toBeNull();
  expect(container.querySelectorAll('mark')).toHaveLength(4);
  expect(screen.getByRole('button', { name: 'src/main.ts:5: find match' })).toBeTruthy();
});

it('collapses individual files and expands or collapses all files', () => {
  show();
  const file = screen.getByRole('button', { name: 'src/main.ts, 2 matching lines' });
  fireEvent.click(file);
  expect(file.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('button', { name: 'src/main.ts:5: find match' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Collapse all files' }));
  expect(screen.queryAllByRole('button', { name: /find match$/ })).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Expand all files' }));
  expect(screen.getAllByRole('button', { name: /find match$/ })).toHaveLength(3);
});

it('opens the first occurrence and keeps highlights tied to the submitted query', () => {
  const { props, container } = show({ query: 'value' });
  fireEvent.click(screen.getByRole('button', { name: 'src/main.ts:5: find match' }));
  expect(props.onOpen).toHaveBeenCalledWith(matches[0], 16);
  expect([...container.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual([
    'find',
    'find',
    'find',
    'find',
  ]);
  expect(screen.getByText('Press Enter to update results.')).toBeTruthy();
});

it('moves keyboard focus through visible rows', () => {
  show();
  const list = screen.getByRole('region', { name: 'Search results' });
  const buttons = within(list).getAllByRole('button');
  buttons[0].focus();
  fireEvent.keyDown(buttons[0], { key: 'ArrowDown' });
  expect(document.activeElement).toBe(buttons[1]);
  fireEvent.keyDown(buttons[1], { key: 'End' });
  expect(document.activeElement).toBe(buttons.at(-1));
});

it('keeps deeply indented matches visible without changing their source position', () => {
  const match = { path: '/project/main.ts', line: 0, text: `${' '.repeat(200)}find(value);` };
  const { container, props } = show({ matches: [match] });
  expect(container.querySelector('code')?.textContent).toBe('find(value);');
  fireEvent.click(screen.getByRole('button', { name: 'main.ts:1: find match' }));
  expect(props.onOpen).toHaveBeenCalledWith(match, 200);
});

it('submits the draft query and disables submission during search or for blank input', () => {
  const { props, rerender } = show();
  fireEvent.submit(screen.getByRole('button', { name: /^Find$/ }).closest('form')!);
  expect(props.onSearch).toHaveBeenCalledOnce();
  rerender(<SearchPanel {...props} searching />);
  expect((screen.getByRole('button', { name: 'Searching…' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  rerender(<SearchPanel {...props} query="   " />);
  expect((screen.getByRole('button', { name: /^Find$/ }) as HTMLButtonElement).disabled).toBe(true);
});

it.each([
  [{ resultQuery: null, matches: [] }, 'Find text across your workspace'],
  [{ resultQuery: 'find', matches: [] }, 'No matching lines'],
  [{ searching: true, matches: [] }, 'Searching workspace…'],
  [{ error: 'Search service unavailable', matches: [] }, 'Search service unavailable'],
])('distinguishes initial, empty, loading and failed searches', (overrides, message) => {
  show(overrides);
  expect(screen.getByText(message)).toBeTruthy();
});

it('shows the result cap and highlights literal punctuation without regex interpretation', () => {
  const { container } = show({
    query: 'a.b',
    resultQuery: 'a.b',
    matches: Array.from({ length: 1000 }, (_, line) => ({
      path: '/project/a.txt',
      line,
      text: 'a.b axb',
    })),
  });
  expect(screen.getByText(/Search stopped at 1,000 matching lines/)).toBeTruthy();
  expect(container.querySelectorAll('mark')).toHaveLength(1000);
  expect(container.querySelector('mark')?.textContent).toBe('a.b');
});
