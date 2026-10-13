// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { api } from './api';
import { open } from '@tauri-apps/plugin-dialog';
import { EditorStore, type OpenEditor } from './editor/editor-store';
import type { WorkspaceSnapshot } from './contracts';
import { updates } from './content/updates';

const editors = vi.hoisted(() => new Map<string, OpenEditor>());
vi.mock('./editor/CodeEditor', () => ({
  CodeEditor: ({ document }: { document: OpenEditor }) => {
    editors.set(document.session.path, document);
    return <div aria-label="Test editor buffer">{document.initial}</div>;
  },
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('./api', () => ({
  request: vi.fn(),
  api: {
    openWorkspace: vi.fn(),
    openDocument: vi.fn(),
    changeDocument: vi.fn(),
    closeDocument: vi.fn(),
    saveDocument: vi.fn(),
    getSetting: vi.fn(),
    setSetting: vi.fn(),
    gitStatus: vi.fn(),
    workspaceStatus: vi.fn(),
    workspaceChanges: vi.fn(),
    cancelNavigation: vi.fn(),
  },
}));
const workspace = (root: string, generation: number): WorkspaceSnapshot => ({
  root,
  name: root.slice(1),
  generation,
  excluded: [],
  contexts: [],
  files: [{ path: `${root}/file.txt`, relativePath: 'file.txt', size: 8 }],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  editors.clear();
  localStorage.clear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  vi.mocked(open).mockResolvedValue('/first');
  vi.mocked(api.getSetting).mockResolvedValue(null);
  vi.mocked(api.setSetting).mockResolvedValue(null);
  vi.mocked(api.openWorkspace).mockImplementation(async (path) =>
    workspace(path, path === '/first' ? 1 : 2),
  );
  vi.mocked(api.openDocument).mockImplementation(async (path) => ({
    path,
    content: 'original',
    revision: 1,
    workspaceGeneration: 1,
    dirty: false,
  }));
  vi.mocked(api.changeDocument).mockImplementation(async (path, revision) => ({
    path,
    revision: revision + 1,
    workspaceGeneration: 1,
    dirty: true,
  }));
  vi.mocked(api.gitStatus).mockResolvedValue({
    branch: 'main',
    head: 'abc',
    files: [],
    fingerprint: 'repo',
    root: '/first',
  });
  vi.mocked(api.workspaceStatus).mockResolvedValue({ generation: 1, contexts: [] });
  vi.mocked(api.workspaceChanges).mockResolvedValue({ paths: [], configurationChanged: false });
  vi.mocked(api.cancelNavigation).mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function openInitialFile() {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: 'Open project…' }));
  fireEvent.click(await screen.findByRole('treeitem', { name: 'file.txt' }));
  await screen.findByLabelText('Test editor buffer');
  return editors.get('/first/file.txt')!;
}
describe('workspace and tab ownership', () => {
  it('defers an unseen update behind an active dialog without losing the startup notification', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    const gate = deferred<string>();
    vi.mocked(api.getSetting).mockImplementation(async (key) =>
      key === 'zwip.updates.lastSeen' ? gate.promise : null,
    );
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const settings = await screen.findByRole('dialog', { name: 'Settings' });
    await act(async () => gate.resolve(updates[1].id));
    expect(screen.queryByRole('dialog', { name: 'What’s new' })).toBeNull();
    fireEvent(settings, new Event('cancel', { bubbles: true, cancelable: true }));
    await screen.findByRole('dialog', { name: 'What’s new' });
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    await waitFor(() =>
      expect(api.setSetting).toHaveBeenCalledWith('zwip.updates.lastSeen', updates[0].id),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent(
      await screen.findByRole('dialog', { name: 'Settings' }),
      new Event('cancel', { bubbles: true, cancelable: true }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'What’s new' })).toBeNull());
  });
  it('retains an open tab when Core returns released:false', async () => {
    const document = await openInitialFile();
    vi.mocked(api.closeDocument).mockResolvedValue({ released: false });
    fireEvent.click(screen.getByRole('button', { name: 'Close file.txt' }));
    await waitFor(() => expect(api.closeDocument).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('retained'));
    expect(screen.getByRole('tab', { name: 'file.txt' })).toBeTruthy();
    expect(editors.get('/first/file.txt')).toBe(document);
  });
  it('waits for queued edits and rechecks dirty ownership before switching', async () => {
    const document = await openInitialFile();
    const gate = deferred<void>();
    const original = EditorStore.prototype.flushAll;
    vi.spyOn(EditorStore.prototype, 'flushAll').mockImplementation(async function (
      this: EditorStore,
    ) {
      await gate.promise;
      await original.call(this);
    });
    vi.mocked(open).mockResolvedValue('/second');
    fireEvent.click(screen.getByRole('button', { name: /first/ }));
    const barrier = await screen.findByRole('dialog', { name: 'Opening workspace' });
    expect(api.openWorkspace).toHaveBeenCalledTimes(1);
    fireEvent(barrier, new Event('cancel', { bubbles: true, cancelable: true }));
    expect(screen.getByRole('dialog', { name: 'Opening workspace' })).toBeTruthy();
    await act(async () => {
      document.session.enqueue([{ from: 8, to: 8, insert: '!' }]);
      gate.resolve();
    });
    await screen.findByRole('dialog', { name: 'Save workspace changes?' });
    expect(api.openWorkspace).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('tab', { name: /file.txt/ })).toBeTruthy();
    expect(document.session.dirty).toBe(true);
  });
  it('keeps the interaction barrier until a workspace open completes', async () => {
    await openInitialFile();
    const reply = deferred<WorkspaceSnapshot>();
    vi.mocked(api.openWorkspace).mockReturnValueOnce(reply.promise);
    vi.mocked(open).mockResolvedValue('/second');
    fireEvent.click(screen.getByRole('button', { name: /first/ }));
    const barrier = await screen.findByRole('dialog', { name: 'Opening workspace' });
    expect(barrier.querySelector('button')).toBeNull();
    expect(screen.getByRole('tab', { name: 'file.txt' })).toBeTruthy();
    await act(async () => reply.resolve(workspace('/second', 2)));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: /second/ })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'file.txt' })).toBeNull();
  });
});
