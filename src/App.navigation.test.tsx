// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { open } from '@tauri-apps/plugin-dialog';
import { listen, type EventCallback } from '@tauri-apps/api/event';
import { App } from './App';
import { api, request } from './api';
import { updates } from './content/updates';
import type { NavigationBatch, NavigationQuery, SourceLocation } from './contracts';

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
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
const source = 'function Run() {}\nRun();\nRun();\n';
const usage: SourceLocation = {
  path,
  range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
  preview: 'Run();',
  name: 'Run',
  contextIds: ['ctx'],
  relationship: 'reference',
};
const secondUsage: SourceLocation = {
  ...usage,
  range: { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } },
};
function reply(query: NavigationQuery, locations = [usage, secondUsage]): NavigationBatch {
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
  vi.mocked(api.getSetting).mockResolvedValue(null);
  vi.mocked(request).mockResolvedValue(null);
  vi.mocked(listen).mockImplementation(async () => () => {});
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
  await within(popup).findByText('2 usages', { exact: false });
  return popup;
}
describe('editor navigation history', () => {
  it('routes native swipe events through editor history and ignores swipes while a dialog is open', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    vi.mocked(api.getSetting).mockImplementation(async (key) =>
      key === 'zwip.updates.lastSeen' ? updates[0].id : null,
    );
    let gesture: EventCallback<unknown> | undefined;
    const unlisten = vi.fn();
    vi.mocked(listen).mockImplementation(async (name, handler) => {
      if (name === 'zwip://navigate-history') {
        gesture = handler;
        return unlisten;
      }
      return () => {};
    });
    const view = await openEditor();
    const at = source.indexOf('Run();') + 2;
    act(() => view.dispatch({ selection: { anchor: at }, userEvent: 'select.pointer' }));
    await waitFor(() => expect(gesture).toBeTypeOf('function'));
    act(() => gesture!({ event: 'zwip://navigate-history', id: 1, payload: 'back' }));
    await waitFor(() => expect(view.state.selection.main.head).toBe(9));
    act(() => gesture!({ event: 'zwip://navigate-history', id: 2, payload: 'forward' }));
    await waitFor(() => expect(view.state.selection.main.head).toBe(at));
    fireEvent.click(screen.getByRole('button', { name: /Search everywhere/ }));
    await screen.findByRole('dialog', { name: 'Search everywhere' });
    act(() => gesture!({ event: 'zwip://navigate-history', id: 3, payload: 'back' }));
    expect(view.state.selection.main.head).toBe(at);
    cleanup();
    await waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
  });
  it('keeps a newer visit when a delayed Forward is superseded by activating a tab', async () => {
    const main = await openEditor();
    const helperPath = `${root}/helper.ts`;
    vi.mocked(api.navigate).mockImplementation(async (query) =>
      reply(query, [{ ...usage, path: helperPath }]),
    );
    findUsages(main);
    await screen.findByLabelText('Editor for helper.ts');
    fireEvent.click(screen.getByRole('button', { name: 'Close helper.ts' }));
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'helper.ts' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Navigation back' }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Navigation forward' }).hasAttribute('disabled'),
      ).toBe(false),
    );
    let finish!: () => void;
    vi.mocked(api.openDocument).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              path: helperPath,
              content: source,
              revision: 1,
              workspaceGeneration: 1,
              dirty: false,
            });
        }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Navigation forward' }));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('tab', { name: 'main.ts' }));
    const restored = EditorView.findFromDOM(screen.getByLabelText('Editor for main.ts'))!;
    const latest = source.lastIndexOf('Run();');
    act(() => restored.dispatch({ selection: { anchor: latest }, userEvent: 'select.pointer' }));
    await act(async () => finish());
    expect(restored.state.selection.main.head).toBe(latest);
    fireEvent.click(screen.getByRole('button', { name: 'Navigation back' }));
    await waitFor(() => expect(restored.state.selection.main.head).toBe(9));
    expect(screen.queryByRole('tab', { name: 'helper.ts' })).toBeNull();
  });
  it('remembers the departure column after keyboard movement on the same line', async () => {
    const view = await openEditor();
    const clicked = source.indexOf('Run();') + 1;
    const departure = clicked + 3;
    act(() => view.dispatch({ selection: { anchor: clicked }, userEvent: 'select.pointer' }));
    act(() => view.dispatch({ selection: { anchor: departure }, userEvent: 'select' }));
    fireEvent.click(screen.getByRole('button', { name: 'Navigation back' }));
    await waitFor(() => expect(view.state.selection.main.head).toBe(9));
    fireEvent.click(screen.getByRole('button', { name: 'Navigation forward' }));
    await waitFor(() => expect(view.state.selection.main.head).toBe(departure));
  });
  it('handles history shortcuts before the editor can use them for indentation', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    vi.mocked(api.getSetting).mockImplementation(async (key) =>
      key === 'shortcuts'
        ? { back: 'Ctrl-[', forward: 'Ctrl-]' }
        : key === 'zwip.updates.lastSeen'
          ? updates[0].id
          : null,
    );
    const view = await openEditor();
    const at = source.indexOf('Run();') + 2;
    act(() => view.dispatch({ selection: { anchor: at }, userEvent: 'select.pointer' }));
    fireEvent.keyDown(view.contentDOM, { key: '[', code: 'BracketLeft', ctrlKey: true });
    await waitFor(() => expect(view.state.selection.main.head).toBe(9));
    fireEvent.keyDown(view.contentDOM, { key: ']', code: 'BracketRight', ctrlKey: true });
    await waitFor(() => expect(view.state.selection.main.head).toBe(at));
    expect(view.state.doc.toString()).toBe(source);
  });
  it('restores clicked line and column in both directions without recording history replay', async () => {
    const view = await openEditor();
    const first = source.indexOf('Run();') + 1;
    const second = source.lastIndexOf('Run();') + 2;
    act(() => view.dispatch({ selection: { anchor: first }, userEvent: 'select.pointer' }));
    act(() => view.dispatch({ selection: { anchor: second }, userEvent: 'select.pointer' }));

    fireEvent.click(screen.getByRole('button', { name: 'Navigation back' }));
    await waitFor(() => expect(view.state.selection.main.head).toBe(first));
    fireEvent.click(screen.getByRole('button', { name: 'Navigation back' }));
    await waitFor(() => expect(view.state.selection.main.head).toBe(9));
    fireEvent.click(screen.getByRole('button', { name: 'Navigation forward' }));
    await waitFor(() => expect(view.state.selection.main.head).toBe(first));
    fireEvent.click(screen.getByRole('button', { name: 'Navigation forward' }));
    await waitFor(() => expect(view.state.selection.main.head).toBe(second));
  });
  it('keeps exact caret locations across tab switches and back or forward navigation', async () => {
    const helperPath = `${root}/helper.ts`;
    vi.mocked(api.openWorkspace).mockResolvedValue({
      root,
      name: 'navigation',
      generation: 1,
      excluded: [],
      contexts: [],
      files: [
        { path, relativePath: 'main.ts', size: source.length },
        { path: helperPath, relativePath: 'helper.ts', size: source.length },
      ],
    });
    const main = await openEditor();
    const mainPosition = source.indexOf('Run();') + 2;
    const helperPosition = source.lastIndexOf('Run();') + 1;
    act(() => main.dispatch({ selection: { anchor: mainPosition }, userEvent: 'select.pointer' }));
    fireEvent.click(screen.getByRole('treeitem', { name: 'helper.ts' }));
    const helperHost = await screen.findByLabelText('Editor for helper.ts');
    const helper = EditorView.findFromDOM(helperHost)!;
    act(() =>
      helper.dispatch({ selection: { anchor: helperPosition }, userEvent: 'select.pointer' }),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'main.ts' }));
    const mainHost = await screen.findByLabelText('Editor for main.ts');
    expect(EditorView.findFromDOM(mainHost)!.state.selection.main.head).toBe(mainPosition);

    fireEvent.click(screen.getByRole('button', { name: 'Navigation back' }));
    const restoredHelper = await screen.findByLabelText('Editor for helper.ts');
    expect(EditorView.findFromDOM(restoredHelper)!.state.selection.main.head).toBe(helperPosition);
    fireEvent.click(screen.getByRole('button', { name: 'Navigation forward' }));
    const restoredMain = await screen.findByLabelText('Editor for main.ts');
    expect(EditorView.findFromDOM(restoredMain)!.state.selection.main.head).toBe(mainPosition);
  });
});
it('keeps settings search available with double Shift before a project is open', async () => {
  render(<App />);
  for (let tap = 0; tap < 2; tap += 1) {
    fireEvent.keyDown(window, { key: 'Shift', shiftKey: true });
    fireEvent.keyUp(window, { key: 'Shift' });
  }
  const search = await screen.findByRole('dialog', { name: 'Search everywhere' });
  fireEvent.change(within(search).getByRole('combobox'), { target: { value: 'settings' } });
  fireEvent.click(within(search).getByRole('option', { name: /Settings:/ }));
  expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeTruthy();
  expect(screen.queryByRole('dialog', { name: 'Search everywhere' })).toBeNull();
});
it('combines search when an existing keymap assigns double Shift to Find action', async () => {
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  vi.mocked(api.getSetting).mockImplementation(async (key) =>
    key === 'shortcuts'
      ? { actions: 'Shift Shift' }
      : key === 'zwip.updates.lastSeen'
        ? updates[0].id
        : null,
  );
  const view = await openEditor();
  for (let tap = 0; tap < 2; tap += 1) {
    fireEvent.keyDown(view.contentDOM, { key: 'Shift', shiftKey: true });
    fireEvent.keyUp(view.contentDOM, { key: 'Shift' });
  }
  const search = await screen.findByRole('dialog', { name: 'Search everywhere' });
  fireEvent.change(within(search).getByRole('combobox'), { target: { value: 'settings' } });
  expect(within(search).getByRole('option', { name: /Settings:/ })).toBeTruthy();
});
it('opens combined search with double Shift and jumps to a function result', async () => {
  const view = await openEditor();
  vi.mocked(request).mockImplementation(async (method, params) =>
    method === 'workspace.symbols'
      ? {
          ...reply({ ...params, documentRevision: 0 } as NavigationQuery, [
            { ...usage, name: 'Run', relationship: 'workspace symbol' },
          ]),
          documentRevision: 0,
        }
      : null,
  );
  for (let tap = 0; tap < 2; tap += 1) {
    fireEvent.keyDown(view.contentDOM, { key: 'Shift', shiftKey: true });
    fireEvent.keyUp(view.contentDOM, { key: 'Shift' });
  }
  const popup = await screen.findByRole('dialog', { name: 'Search everywhere' });
  const input = within(popup).getByRole('combobox');
  fireEvent.change(input, { target: { value: 'Run' } });
  const result = await within(popup).findByText('Run', { selector: 'strong' });
  fireEvent.click(result.closest('button')!);
  await waitFor(() => expect(view.state.selection.main.head).toBe(source.indexOf('Run();')));
  expect(screen.queryByRole('dialog', { name: 'Search everywhere' })).toBeNull();
});
describe('usages navigation', () => {
  it('jumps directly to a single complete usage without opening a popup', async () => {
    const view = await openEditor();
    vi.mocked(api.navigate).mockImplementation(async (query) => reply(query, [usage]));
    findUsages(view);
    expect(screen.queryByRole('dialog', { name: 'Usages of Run' })).toBeNull();
    await waitFor(() => expect(view.state.selection.main.head).toBe(source.indexOf('Run();')));
    expect(screen.queryByRole('dialog', { name: 'Usages of Run' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Usages' })).toBeNull();
    expect(document.activeElement).toBe(view.contentDOM);
  });
  it('jumps directly to a single definition', async () => {
    const view = await openEditor();
    const declaration = {
      ...usage,
      relationship: 'definition',
      range: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } },
    };
    vi.mocked(api.navigate).mockImplementation(async (query) => reply(query, [declaration]));
    act(() => view.dispatch({ selection: { anchor: source.indexOf('Run();') } }));
    vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue(source.indexOf('Run();') + 1);
    fireEvent.mouseDown(view.contentDOM, { metaKey: true, button: 0 });
    await waitFor(() => expect(view.state.selection.main.head).toBe(9));
    expect(api.navigate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Usages of Run' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Usages' })).toBeNull();
  });
  it('opens the file and line of a single usage in another file', async () => {
    await openEditor();
    const destination = `${root}/helper.ts`;
    vi.mocked(api.navigate).mockImplementation(async (query) =>
      reply(query, [{ ...usage, path: destination }]),
    );
    const sourceEditor = EditorView.findFromDOM(screen.getByLabelText('Editor for main.ts'))!;
    findUsages(sourceEditor);
    const host = await screen.findByLabelText('Editor for helper.ts');
    const target = EditorView.findFromDOM(host)!;
    await waitFor(() => expect(target.state.selection.main.head).toBe(source.indexOf('Run();')));
    expect(screen.queryByRole('dialog', { name: 'Usages of Run' })).toBeNull();
  });
  it('opens a command-click target using the canonical path returned by the backend', async () => {
    const view = await openEditor();
    const requested = `${root}/linked/helper.ts`;
    const canonical = `${root}/pkg/helper.ts`;
    vi.mocked(api.openDocument).mockImplementation(async (requestedPath) => ({
      path: requestedPath === requested ? canonical : requestedPath,
      content: source,
      revision: 1,
      workspaceGeneration: 1,
      dirty: false,
    }));
    vi.mocked(api.navigate).mockImplementation(async (query) =>
      reply(query, [{ ...usage, path: requested, relationship: 'definition' }]),
    );
    vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue(source.indexOf('Run();') + 1);
    fireEvent.mouseDown(view.contentDOM, { metaKey: true, button: 0 });

    const host = await screen.findByLabelText('Editor for helper.ts');
    expect(EditorView.findFromDOM(host)!.state.doc.toString()).toBe(source);
    expect(screen.getByRole('tab', { name: 'helper.ts' }).getAttribute('title')).toBe(canonical);
    expect(screen.queryByText('Open a file to start editing')).toBeNull();
  });
  it('retains a previewed usage when its tab opens while preview cleanup is pending', async () => {
    const view = await openEditor();
    const destination = `${root}/helper.ts`;
    vi.mocked(api.navigate).mockImplementation(async (query) =>
      reply(query, [
        { ...usage, path: destination },
        { ...secondUsage, path: destination },
      ]),
    );
    let releasePreview: (() => void) | undefined;
    vi.mocked(api.closeDocument).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releasePreview = () => resolve({ released: true });
        }),
    );
    findUsages(view);
    const popup = await completedPopup();
    const preview = await screen.findByLabelText(`Preview of ${destination}`);
    await waitFor(() => expect(preview.querySelector('.cm-content')).not.toBeNull());
    fireEvent.click(within(popup).getAllByRole('option')[0]);
    const host = await screen.findByLabelText('Editor for helper.ts');
    expect(EditorView.findFromDOM(host)!.state.selection.main.head).toBe(source.indexOf('Run();'));

    await act(async () => releasePreview?.());

    expect(screen.getByLabelText('Editor for helper.ts')).toBe(host);
    expect(screen.getByRole('tab', { name: 'helper.ts' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.queryByText('Open a file to start editing')).toBeNull();
  });
  it('jumps from a declaration to its only usage', async () => {
    const view = await openEditor();
    const declaration = {
      ...usage,
      relationship: 'definition',
      range: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } },
    };
    vi.mocked(api.navigate).mockImplementation(async (query) =>
      reply(query, query.operation === 'definition' ? [declaration] : [usage]),
    );
    vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue(12);
    fireEvent.mouseDown(view.contentDOM, { metaKey: true, button: 0 });
    await waitFor(() => expect(view.state.selection.main.head).toBe(source.indexOf('Run();')));
    expect(vi.mocked(api.navigate).mock.calls.map(([query]) => query.operation)).toEqual([
      'definition',
      'references',
    ]);
    expect(screen.queryByRole('dialog', { name: 'Usages of Run' })).toBeNull();
  });
  it('keeps the target chooser for multiple definitions', async () => {
    const view = await openEditor();
    vi.mocked(api.navigate).mockImplementation(async (query) =>
      reply(query, [
        { ...usage, path: `${root}/first.ts`, relationship: 'definition' },
        { ...usage, path: `${root}/second.ts`, relationship: 'definition' },
      ]),
    );
    vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue(source.indexOf('Run();') + 1);
    fireEvent.mouseDown(view.contentDOM, { metaKey: true, button: 0 });
    const chooser = await screen.findByRole('dialog', { name: 'Choose a target' });
    expect(within(chooser).getAllByRole('option')).toHaveLength(2);
    expect(view.state.selection.main.head).toBe(9);
    fireEvent.doubleClick(within(chooser).getAllByRole('option')[0]);
    await screen.findByLabelText('Editor for first.ts');
    fireEvent.click(screen.getByRole('button', { name: 'Navigation back' }));
    const restored = await screen.findByLabelText('Editor for main.ts');
    expect(EditorView.findFromDOM(restored)!.state.selection.main.head).toBe(
      source.indexOf('Run();') + 1,
    );
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
  it('waits for pending edits before choosing whether to open a popup', async () => {
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
    expect(screen.queryByRole('dialog', { name: 'Usages of Run' })).toBeNull();
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
      reply(query, query.operation === 'definition' ? [declaration] : [usage, secondUsage]),
    );
    vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue(12);
    fireEvent.mouseDown(view.contentDOM, { metaKey: true, button: 0 });
    await completedPopup();
    expect(vi.mocked(api.navigate).mock.calls.map(([query]) => query.operation)).toEqual([
      'definition',
      'references',
    ]);
  });
  it('waits for a pending single-result search and then jumps without a popup', async () => {
    const view = await openEditor();
    let finish!: () => void;
    vi.mocked(api.navigate).mockImplementation(
      (query) =>
        new Promise((resolve) => {
          finish = () => resolve(reply(query, [usage]));
        }),
    );
    findUsages(view);
    await waitFor(() => expect(api.navigate).toHaveBeenCalled());
    expect(screen.queryByRole('dialog', { name: 'Usages of Run' })).toBeNull();
    expect(view.state.selection.main.head).toBe(9);
    await act(async () => finish());
    await waitFor(() => expect(view.state.selection.main.head).toBe(source.indexOf('Run();')));
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
        query.operation === 'definition'
          ? [declaration]
          : [
              { ...usage, path: previewPath },
              { ...secondUsage, path: previewPath },
            ],
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
  it.each([{ locations: [] }, { locations: [usage] }])(
    'keeps incomplete coverage visible even with zero or one result: %j',
    async ({ locations }) => {
      const view = await openEditor();
      vi.mocked(api.navigate).mockImplementation(async (query) => ({
        ...reply(query, locations),
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
    },
  );
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
