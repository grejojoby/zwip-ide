// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { open } from '@tauri-apps/plugin-dialog';
import { App } from './App';
import { api } from './api';

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('./api', () => ({
  request: vi.fn(async () => null),
  api: {
    openWorkspace: vi.fn(),
    indexWorkspace: vi.fn(async () => ({ started: [], unavailable: [] })),
    scratches: vi.fn(async () => ({ dir: '/scratches', files: [] })),
    openDocument: vi.fn(),
    closeDocument: vi.fn(async () => ({ released: true })),
    changeDocument: vi.fn(),
    getSetting: vi.fn(async () => null),
    setSetting: vi.fn(async () => null),
    gitStatus: vi.fn(async () => ({ branch: 'main', files: [], fingerprint: 'repo' })),
    workspaceStatus: vi.fn(async () => ({ generation: 1, contexts: [] })),
    workspaceChanges: vi.fn(async () => ({ paths: [], configurationChanged: false })),
    connections: vi.fn(async () => [
      { id: 'one', name: 'Orders', kind: 'sqlite', config: { path: '/one.db' } },
      { id: 'two', name: 'Reporting', kind: 'sqlite', config: { path: '/two.db' } },
    ]),
    queryConsole: vi.fn(async (id: string) => ({
      content: id === 'one' ? 'SELECT 1;\nSELECT 2;' : 'SELECT 3;',
    })),
    saveQueryConsole: vi.fn(async (_id: string, content: string) => ({ content })),
    toolRequest: vi.fn(async (_package: string, method: string) =>
      method === 'query' ? { columns: ['answer'], rows: [{ answer: 2 }], done: true } : [],
    ),
    navigate: vi.fn(),
    navigationProgress: vi.fn(async () => null),
    cancelNavigation: vi.fn(async () => undefined),
    editorRequest: vi.fn(async () => null),
  },
}));
const root = '/navigation';
const path = `${root}/main.ts`;
const source = 'function Run() {}\nRun();\nRun();\n';
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  vi.spyOn(EditorView.prototype, 'coordsAtPos').mockReturnValue({
    left: 40,
    right: 48,
    top: 100,
    bottom: 118,
  });
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  vi.mocked(open).mockResolvedValue(root);
  vi.mocked(api.openWorkspace).mockResolvedValue({
    root,
    name: 'navigation',
    generation: 1,
    excluded: [],
    contexts: [],
    files: [{ path, relativePath: 'main.ts', size: source.length }],
  });
  vi.mocked(api.openDocument).mockImplementation(async (path) => ({
    path,
    content: source,
    revision: 1,
    workspaceGeneration: 1,
    dirty: false,
  }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function openEditor() {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: 'Open project…' }));
  fireEvent.click(await screen.findByRole('treeitem', { name: 'main.ts' }));
  const host = await screen.findByLabelText('Editor for main.ts');
  const view = EditorView.findFromDOM(host)!;
  act(() => view.dispatch({ selection: { anchor: 9 } }));
  return view;
}

async function chooseConnection(id: string) {
  const selector = await screen.findByLabelText('Saved database connection');
  await within(selector).findByRole('option', {
    name: id === 'one' ? 'Orders · sqlite' : 'Reporting · sqlite',
  });
  fireEvent.change(selector, { target: { value: id } });
}
async function sqlEditor(name: string) {
  return within(
    await screen.findByRole('region', { name: `SQL console for ${name}` }),
  ).findByLabelText('SQL query');
}
it('opens one connection-named editor tab and preserves its editor and undo across tabs and hiding Database', async () => {
  await openEditor();
  fireEvent.click(screen.getByRole('button', { name: 'Database tools' }));
  await chooseConnection('one');
  const tab = await screen.findByRole('tab', { name: 'Orders' });
  const host = await sqlEditor('Orders');
  const editor = EditorView.findFromDOM(host)!;
  act(() =>
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'SELECT 99;' } }),
  );
  const database = screen.getByRole('region', { name: 'Database tools' });
  expect(database.contains(host)).toBe(false);
  fireEvent.click(screen.getByRole('tab', { name: 'main.ts' }));
  fireEvent.click(tab);
  expect(EditorView.findFromDOM(await sqlEditor('Orders'))).toBe(editor);
  expect(editor.state.doc.toString()).toBe('SELECT 99;');
  fireEvent.click(screen.getByLabelText('Close Database tool'));
  expect(screen.queryByRole('region', { name: 'Database tools' })).toBeNull();
  expect(EditorView.findFromDOM(await sqlEditor('Orders'))).toBe(editor);
  act(() => {
    undo(editor);
  });
  expect(editor.state.doc.toString()).toBe('SELECT 1;\nSELECT 2;');
  fireEvent.click(screen.getByRole('button', { name: 'Database tools' }));
  await chooseConnection('two');
  await screen.findByRole('tab', { name: 'Reporting' });
  expect((await sqlEditor('Reporting')).textContent).toContain('SELECT 3;');
  fireEvent.click(tab);
  expect(EditorView.findFromDOM(await sqlEditor('Orders'))).toBe(editor);
  fireEvent.click(screen.getByRole('button', { name: 'Open SQL console' }));
  expect(screen.getAllByRole('tab', { name: 'Orders' })).toHaveLength(1);
});
it('runs only selected SQL from its owning connection and reveals its results panel', async () => {
  await openEditor();
  fireEvent.click(screen.getByRole('button', { name: 'Database tools' }));
  await chooseConnection('one');
  await screen.findByRole('tab', { name: 'Orders' });
  const editor = EditorView.findFromDOM(await sqlEditor('Orders'))!;
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Execute' }).hasAttribute('disabled')).toBe(false),
  );
  await chooseConnection('two');
  await screen.findByRole('tab', { name: 'Reporting' });
  fireEvent.click(screen.getByRole('tab', { name: 'Orders' }));
  fireEvent.click(screen.getByLabelText('Close Database tool'));
  act(() => editor.dispatch({ selection: { anchor: 10, head: editor.state.doc.length } }));
  fireEvent.keyDown(editor.contentDOM, { key: 'Enter', code: 'Enter', metaKey: true });
  await waitFor(() =>
    expect(api.toolRequest).toHaveBeenCalledWith(
      'sql',
      'query',
      expect.objectContaining({ connectionId: 'one', sql: 'SELECT 2;' }),
    ),
  );
  expect(screen.getByRole('region', { name: 'Database tools' })).toBeTruthy();
  expect((screen.getByLabelText('Saved database connection') as HTMLSelectElement).value).toBe(
    'one',
  );
  expect(await screen.findByRole('columnheader', { name: 'answer' })).toBeTruthy();
});
it('flushes the owning console when its tab closes and reloads saved text on reopening', async () => {
  await openEditor();
  fireEvent.click(screen.getByRole('button', { name: 'Database tools' }));
  await chooseConnection('one');
  await screen.findByRole('tab', { name: 'Orders' });
  const editor = EditorView.findFromDOM(await sqlEditor('Orders'))!;
  act(() =>
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'SELECT 77;' } }),
  );
  fireEvent.click(screen.getByLabelText('Close SQL console Orders'));
  await waitFor(() => expect(screen.queryByRole('tab', { name: 'Orders' })).toBeNull());
  await waitFor(() => expect(api.saveQueryConsole).toHaveBeenCalledWith('one', 'SELECT 77;'));
  vi.mocked(api.queryConsole).mockResolvedValueOnce({ content: 'SELECT 77;' });
  fireEvent.click(screen.getByRole('button', { name: 'Open SQL console' }));
  await screen.findByRole('tab', { name: 'Orders' });
  await waitFor(async () =>
    expect((await sqlEditor('Orders')).textContent).toContain('SELECT 77;'),
  );
});

it('retains the editor buffer when saving on close fails', async () => {
  await openEditor();
  fireEvent.click(screen.getByRole('button', { name: 'Database tools' }));
  await chooseConnection('one');
  const editor = EditorView.findFromDOM(await sqlEditor('Orders'))!;
  act(() =>
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: 'SELECT important_work;' },
    }),
  );
  vi.mocked(api.saveQueryConsole).mockRejectedValue(new Error('Disk full'));
  fireEvent.click(screen.getByLabelText('Close SQL console Orders'));
  await screen.findByText(/SQL console retained because saving failed: Disk full/);
  expect(screen.getByRole('tab', { name: 'Orders' })).toBeTruthy();
  expect(editor.state.doc.toString()).toBe('SELECT important_work;');
  vi.mocked(api.saveQueryConsole).mockResolvedValue({ content: 'SELECT important_work;' });
  fireEvent.click(screen.getByLabelText('Close SQL console Orders'));
  await waitFor(() => expect(screen.queryByRole('tab', { name: 'Orders' })).toBeNull());
});

it('keeps a reopened console when an earlier close finishes saving', async () => {
  await openEditor();
  fireEvent.click(screen.getByRole('button', { name: 'Database tools' }));
  await chooseConnection('one');
  const editor = EditorView.findFromDOM(await sqlEditor('Orders'))!;
  act(() =>
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: 'SELECT keep_open;' },
    }),
  );
  let finishSave: (() => void) | undefined;
  vi.mocked(api.saveQueryConsole).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishSave = () => resolve({ content: 'SELECT keep_open;' });
      }),
  );
  fireEvent.click(screen.getByLabelText('Close SQL console Orders'));
  await waitFor(() =>
    expect(api.saveQueryConsole).toHaveBeenCalledWith('one', 'SELECT keep_open;'),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open SQL console' }));
  await act(async () => {
    finishSave!();
  });
  expect(screen.getByRole('tab', { name: 'Orders' })).toBeTruthy();
  expect(EditorView.findFromDOM(await sqlEditor('Orders'))).toBe(editor);
  expect(editor.state.doc.toString()).toBe('SELECT keep_open;');
});
