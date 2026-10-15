// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { open } from '@tauri-apps/plugin-dialog';
import { App } from './App';
import { api } from './api';
import type { NavigationBatch, NavigationQuery, SourceLocation } from './contracts';

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
    navigate: vi.fn(),
    navigationProgress: vi.fn(async () => null),
    cancelNavigation: vi.fn(async () => undefined),
    editorRequest: vi.fn(async () => null),
  },
}));
const root = '/navigation';
const path = `${root}/main.ts`;
const source = 'function Run() {}\nRun();\n';
const usage: SourceLocation = {
  path,
  range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
  preview: 'Run();',
  name: 'Run',
  contextIds: ['ctx'],
  relationship: 'reference',
};
function reply(query: NavigationQuery, locations = [usage]): NavigationBatch {
  return {
    ...query,
    state: 'complete',
    locations,
    searchedContexts: 1,
    totalContexts: 1,
    reasons: [],
  };
}
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
  vi.mocked(api.navigate).mockImplementation(async (query) => reply(query));
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
function findUsages(view: EditorView) {
  fireEvent.keyDown(view.contentDOM, { key: 'F7', code: 'F7', altKey: true });
}
async function completedPopup() {
  const popup = await screen.findByRole('dialog', { name: 'Usages of Run' });
  await within(popup).findByText('1 usage', { exact: false });
  return popup;
}
describe('usages navigation', () => {
  it('keeps a single usage in the popup and only opens it when selected', async () => {
    const view = await openEditor();
    findUsages(view);
    const popup = await completedPopup();
    expect(screen.queryByRole('region', { name: 'Usages' })).toBeNull();
    expect(view.state.selection.main.head).toBe(9);
    fireEvent.keyDown(within(popup).getByRole('listbox'), { key: 'Enter' });
    await waitFor(() => expect(view.state.selection.main.head).toBe(source.indexOf('Run();')));
    expect(screen.queryByRole('dialog', { name: 'Usages of Run' })).toBeNull();
  });
  it('docks only the selected search and opens the next search in a popup', async () => {
    const view = await openEditor();
    findUsages(view);
    await completedPopup();
    fireEvent.click(screen.getByRole('button', { name: 'Dock to bottom panel' }));
    expect(screen.getByRole('region', { name: 'Usages' })).toBeTruthy();
    act(() => view.focus());
    findUsages(view);
    await completedPopup();
    expect(screen.queryByRole('region', { name: 'Usages' })).toBeNull();
  });
  it('opens a popup even when the caret has no viewport coordinates', async () => {
    const view = await openEditor();
    vi.mocked(EditorView.prototype.coordsAtPos).mockReturnValue(null);
    findUsages(view);
    await completedPopup();
    expect(screen.queryByRole('region', { name: 'Usages' })).toBeNull();
  });
  it('returns keyboard focus to the editor when the popup closes or docks', async () => {
    const view = await openEditor();
    findUsages(view);
    const popup = await completedPopup();
    fireEvent.keyDown(within(popup).getByRole('listbox'), { key: 'Escape' });
    expect(document.activeElement).toBe(view.contentDOM);
    findUsages(view);
    await completedPopup();
    fireEvent.click(screen.getByRole('button', { name: 'Dock to bottom panel' }));
    expect(document.activeElement).toBe(view.contentDOM);
  });
  it('shows loading before pending document changes finish flushing', async () => {
    const view = await openEditor();
    let acknowledge!: () => void;
    vi.mocked(api.changeDocument).mockImplementation(
      () =>
        new Promise((resolve) => {
          acknowledge = () => resolve({ path, revision: 2, workspaceGeneration: 1, dirty: true });
        }),
    );
    act(() => view.dispatch({ changes: { from: source.length, insert: ' ' } }));
    await waitFor(() => expect(api.changeDocument).toHaveBeenCalled());
    findUsages(view);
    const popup = screen.getByRole('dialog', { name: 'Usages of Run' });
    expect(within(popup).getByText('Searching…', { exact: false })).toBeTruthy();
    expect(api.navigate).not.toHaveBeenCalled();
    await act(async () => acknowledge());
    await completedPopup();
    expect(api.navigate).toHaveBeenCalledWith(expect.objectContaining({ documentRevision: 2 }));
  });
  it('switches from a declaration at the end of its name to usages', async () => {
    const view = await openEditor();
    const declaration = {
      ...usage,
      relationship: 'definition',
      range: {
        start: { line: 0, character: 9 },
        end: { line: 0, character: 12 },
      },
    };
    vi.mocked(api.navigate).mockImplementation(async (query) =>
      reply(query, query.operation === 'definition' ? [declaration] : [usage]),
    );
    vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue(12);
    fireEvent.mouseDown(view.contentDOM, { metaKey: true, button: 0 });
    await completedPopup();
    expect(vi.mocked(api.navigate).mock.calls.map(([query]) => query.operation)).toEqual([
      'definition',
      'references',
    ]);
  });
  it('keeps docking a pending search after its result arrives', async () => {
    const view = await openEditor();
    let finish!: () => void;
    vi.mocked(api.navigate).mockImplementation(
      (query) =>
        new Promise((resolve) => {
          finish = () => resolve(reply(query));
        }),
    );
    findUsages(view);
    await waitFor(() => expect(api.navigate).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Dock to bottom panel' }));
    await act(async () => finish());
    const dock = screen.getByRole('region', { name: 'Usages' });
    expect(within(dock).getByText('1 result', { exact: false })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Usages of Run' })).toBeNull();
  });
  it('starts a fresh usages popup from a declaration in a preview without an editor tab', async () => {
    const view = await openEditor();
    const previewPath = `${root}/helper.ts`;
    const declaration = {
      ...usage,
      path: previewPath,
      relationship: 'definition',
      range: {
        start: { line: 0, character: 9 },
        end: { line: 0, character: 12 },
      },
    };
    vi.mocked(api.navigate).mockImplementation(async (query) =>
      reply(
        query,
        query.operation === 'definition' ? [declaration] : [{ ...usage, path: previewPath }],
      ),
    );
    findUsages(view);
    await completedPopup();
    const preview = await screen.findByLabelText('Preview of /navigation/helper.ts');
    await waitFor(() => expect(preview.querySelector('.cm-content')).not.toBeNull());
    vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue(10);
    fireEvent.mouseDown(preview.querySelector('.cm-content')!, { metaKey: true, button: 0 });
    await waitFor(() => expect(api.navigate).toHaveBeenCalledTimes(3));
    await completedPopup();
    expect(screen.queryByRole('region', { name: 'Usages' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'helper.ts' })).toBeNull();
    expect(api.navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        path: previewPath,
        operation: 'references',
        position: { line: 0, character: 10 },
      }),
    );
  });
  it('keeps incomplete coverage and provider reasons visible in the popup', async () => {
    const view = await openEditor();
    vi.mocked(api.navigate).mockImplementation(async (query) => ({
      ...reply(query, []),
      state: 'partial',
      searchedContexts: 0,
      reasons: ['The source context is still indexing.'],
    }));
    findUsages(view);
    const popup = await screen.findByRole('dialog', { name: 'Usages of Run' });
    await within(popup).findByText('The source context is still indexing.');
    expect(within(popup).getByText('partial')).toBeTruthy();
    expect(within(popup).queryByText('No usages in the searched contexts.')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Usages' })).toBeNull();
  });
  it('ignores a canceled search that finishes after the newer search', async () => {
    const view = await openEditor();
    let finishOld!: () => void;
    vi.mocked(api.navigate).mockImplementationOnce(
      (query) =>
        new Promise((resolve) => {
          finishOld = () => resolve(reply(query, [{ ...usage, preview: 'old result' }]));
        }),
    );
    findUsages(view);
    await waitFor(() => expect(api.navigate).toHaveBeenCalledTimes(1));
    act(() => view.focus());
    findUsages(view);
    await completedPopup();
    expect(api.cancelNavigation).toHaveBeenCalledWith(vi.mocked(api.navigate).mock.calls[0][0].id);
    await act(async () => finishOld());
    const popup = await completedPopup();
    expect(within(popup).queryByText('old result')).toBeNull();
  });
});
