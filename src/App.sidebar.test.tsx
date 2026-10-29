// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { api, request } from './api';
import { open } from '@tauri-apps/plugin-dialog';
import type { OpenEditor } from './editor/editor-store';
import type { WorkspaceSnapshot } from './contracts';
import { updates } from './content/updates';

const panels = vi.hoisted(() => ({
  editors: new Map<string, OpenEditor>(),
  gitMounts: 0,
}));
vi.mock('./editor/CodeEditor', () => ({
  CodeEditor: ({ document }: { document: OpenEditor }) => {
    panels.editors.set(document.session.path, document);
    return <div aria-label="Test editor buffer">{document.initial}</div>;
  },
}));
// Stateful provider boundaries make remounts observable while App/ProjectTree,
// layout persistence, editor sessions and confirmation dialogs remain real.
vi.mock('./components/GitPanel', async () => {
  const { useState } = await import('react');
  return {
    GitPanel: () => {
      const [draft, setDraft] = useState(() => {
        panels.gitMounts++;
        return '';
      });
      return (
        <section aria-label="Git changes">
          <input
            aria-label="Git commit draft"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </section>
      );
    },
  };
});
vi.mock('./components/tools/SqlConsole', () => ({
  SqlConsole: () => <textarea aria-label="SQL query" />,
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('./api', () => ({
  request: vi.fn(async () => ({})),
  api: {
    openWorkspace: vi.fn(),
    indexWorkspace: vi.fn(async () => ({ started: [], unavailable: [] })),
    scratches: vi.fn(async () => ({ dir: '/scratches', files: [] })),
    openDocument: vi.fn(),
    changeDocument: vi.fn(),
    closeDocument: vi.fn(),
    saveDocument: vi.fn(),
    getSetting: vi.fn(),
    setSetting: vi.fn(),
    gitStatus: vi.fn(),
    search: vi.fn(),
    pushPlan: vi.fn(),
    push: vi.fn(),
    workspaceStatus: vi.fn(),
    workspaceChanges: vi.fn(),
    cancelNavigation: vi.fn(),
    connections: vi.fn(),
    queryConsole: vi.fn(),
    saveQueryConsole: vi.fn(),
    toolRequest: vi.fn(),
  },
}));
const root = '/sidebar-fixture';
const layoutKey = `zwip.${root}.sidebarLayout`;
const storage = new Map<string, unknown>();
const workspace: WorkspaceSnapshot = {
  root,
  name: 'sidebar-fixture',
  generation: 1,
  excluded: [],
  contexts: [],
  directories: [`${root}/folder`],
  files: [
    { path: `${root}/folder/file.txt`, relativePath: 'folder/file.txt', size: 8 },
    { path: `${root}/notes.txt`, relativePath: 'notes.txt', size: 8 },
  ],
};
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  storage.clear();
  panels.editors.clear();
  panels.gitMounts = 0;
  storage.set('zwip.updates.lastSeen', updates[0].id);
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
  vi.mocked(api.connections).mockResolvedValue([
    { id: 'db', name: 'Demo', kind: 'sqlite', config: { path: '/db.sqlite' } },
  ]);
  vi.mocked(api.queryConsole).mockResolvedValue({ content: '' });
  vi.mocked(api.saveQueryConsole).mockResolvedValue({ content: '' });
  vi.mocked(api.toolRequest).mockResolvedValue([]);
  vi.mocked(open).mockResolvedValue(root);
  vi.mocked(api.getSetting).mockImplementation(async (key) => storage.get(key) ?? null);
  vi.mocked(api.setSetting).mockImplementation(async (key, value) => {
    storage.set(key, structuredClone(value));
    return value;
  });
  vi.mocked(api.openWorkspace).mockResolvedValue(workspace);
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
    root,
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
const panel = (tool: string) => {
  const element = document.getElementById(`sidebar-panel-${tool}`);
  expect(element, `Expected stable ${tool} host`).not.toBeNull();
  return element!;
};
const visible = (element: HTMLElement) =>
  !element.hidden && getComputedStyle(element).display !== 'none';
function railButton(side: 'left' | 'right', tool: string) {
  const rail = screen.getByRole('navigation', {
    name: `${side === 'left' ? 'Left' : 'Right'} tool windows`,
  });
  const button = rail.querySelector<HTMLButtonElement>(`[data-sidebar-tool="${tool}"]`);
  expect(button).not.toBeNull();
  return button!;
}
async function openWorkspace() {
  const view = render(<App />);
  fireEvent.click(screen.getByRole('button', { name: 'Open project…' }));
  await screen.findByLabelText('Filter project files');
  return view;
}
async function move(tool: string, side: 'left' | 'right') {
  fireEvent.click(screen.getByRole('button', { name: `Move ${tool}` }));
  const dialog = await screen.findByRole('dialog', { name: `Move ${tool}` });
  fireEvent.click(within(dialog).getByRole('button', { name: `Move to ${side} sidebar` }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: `Move ${tool}` })).toBeNull());
}

describe('sidebar panel ownership', () => {
  it('hydrates canonical workspace preferences and enables sidebar controls when opening an alias', async () => {
    vi.mocked(open).mockResolvedValue('/workspace-alias/');
    storage.set(layoutKey, {
      version: 1,
      placements: { project: 'left', git: 'right', database: 'right', http: 'right' },
      active: { left: 'project', right: null },
    });
    await openWorkspace();
    const gitButton = railButton('right', 'git');
    await waitFor(() => expect(gitButton.disabled).toBe(false));
    expect(api.getSetting).toHaveBeenCalledWith(layoutKey);
    fireEvent.click(gitButton);
    await screen.findByLabelText('Git commit draft');
    await move('Git', 'left');
    await waitFor(() =>
      expect(storage.get(layoutKey)).toMatchObject({ placements: { git: 'left' } }),
    );
    expect(storage.has('zwip./workspace-alias/.sidebarLayout')).toBe(false);
  });

  it('ignores delayed preferences from an earlier visit after opening A, B, then A again', async () => {
    let resolveFirst!: (value: unknown) => void;
    const firstPreferences = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    let visits = 0;
    vi.mocked(api.getSetting).mockImplementation(async (key) => {
      if (key === layoutKey && ++visits === 1) return firstPreferences;
      return storage.get(key) ?? null;
    });
    vi.mocked(api.openWorkspace).mockImplementation(async (requested) => ({
      ...workspace,
      root: requested,
      name: requested === root ? 'sidebar-fixture' : 'other-fixture',
      generation: vi.mocked(api.openWorkspace).mock.calls.length,
    }));
    await openWorkspace();
    await waitFor(() => expect(visits).toBe(1));
    vi.mocked(open).mockResolvedValue('/other-fixture');
    fireEvent.click(screen.getByRole('button', { name: /sidebar-fixture/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'This window' }));
    await screen.findByRole('button', { name: /other-fixture/ });
    await waitFor(() => expect(railButton('right', 'git').disabled).toBe(false));
    storage.set(layoutKey, {
      version: 1,
      placements: { project: 'right', git: 'left', database: 'right', http: 'right' },
      active: { left: 'git', right: 'project' },
    });
    vi.mocked(open).mockResolvedValue(root);
    fireEvent.click(screen.getByRole('button', { name: /other-fixture/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'This window' }));
    await screen.findByLabelText('Git commit draft');
    expect(panel('git').dataset.sidebarSide).toBe('left');
    await act(async () => {
      resolveFirst({
        version: 1,
        placements: { project: 'left', git: 'right', database: 'right', http: 'right' },
        active: { left: 'project', right: null },
      });
      await firstPreferences;
    });
    expect(panel('git').dataset.sidebarSide).toBe('left');
    expect(visible(panel('git'))).toBe(true);
    expect(panel('project').dataset.sidebarSide).toBe('right');
    expect(storage.get(layoutKey)).toMatchObject({ placements: { git: 'left', project: 'right' } });
  });

  it('switches Git with Project on the left while preserving each panel and the unsaved editor', async () => {
    await openWorkspace();
    fireEvent.click(screen.getByRole('treeitem', { name: 'folder' }));
    fireEvent.click(screen.getByRole('treeitem', { name: 'file.txt' }));
    await screen.findByLabelText('Test editor buffer');
    const editor = panels.editors.get(`${root}/folder/file.txt`)!;
    await act(async () => {
      editor.session.enqueue([{ from: 8, to: 8, insert: ' unsaved' }]);
      await editor.session.flush();
    });
    const filter = screen.getByLabelText('Filter project files');
    fireEvent.change(filter, { target: { value: 'file' } });
    const projectHost = panel('project');
    fireEvent.click(railButton('right', 'git'));
    const draft = await screen.findByLabelText('Git commit draft');
    fireEvent.change(draft, { target: { value: 'Keep this draft' } });
    const gitHost = panel('git');
    await move('Git', 'left');
    expect(panel('git')).toBe(gitHost);
    expect(gitHost.dataset.sidebarSide).toBe('left');
    expect(visible(gitHost)).toBe(true);
    expect(visible(projectHost)).toBe(false);
    fireEvent.click(railButton('left', 'project'));
    expect(panel('project')).toBe(projectHost);
    expect(screen.getByLabelText('Filter project files')).toBe(filter);
    expect((filter as HTMLInputElement).value).toBe('file');
    expect(visible(gitHost)).toBe(false);
    fireEvent.click(railButton('left', 'git'));
    expect(screen.getByLabelText('Git commit draft')).toBe(draft);
    expect((draft as HTMLInputElement).value).toBe('Keep this draft');
    expect(panels.gitMounts).toBe(1);
    expect(panels.editors.get(`${root}/folder/file.txt`)).toBe(editor);
    expect(editor.session.dirty).toBe(true);
    expect(api.saveDocument).not.toHaveBeenCalled();
    expect(api.closeDocument).not.toHaveBeenCalled();
    fireEvent.click(railButton('left', 'project'));
    fireEvent.change(filter, { target: { value: '' } });
    expect(screen.getByRole('treeitem', { name: 'file.txt' })).toBeTruthy();
  });

  it('persists placement and active windows, then restores them when reopening the workspace', async () => {
    const view = await openWorkspace();
    expect(screen.queryByRole('button', { name: 'Move Project' })).toBeNull();
    fireEvent.contextMenu(railButton('left', 'project'));
    const projectMenu = await screen.findByRole('dialog', { name: 'Move Project' });
    fireEvent.click(within(projectMenu).getByRole('button', { name: 'Move to right sidebar' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Move Project' })).toBeNull());
    fireEvent.click(railButton('right', 'git'));
    await screen.findByLabelText('Git commit draft');
    // Keyboard menu access must match pointer/context-menu behavior.
    fireEvent.keyDown(railButton('right', 'git'), { key: 'F10', shiftKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Move Git' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move to left sidebar' }));
    await waitFor(() =>
      expect(storage.get(layoutKey)).toMatchObject({
        version: 1,
        placements: { project: 'right', git: 'left' },
        active: { left: 'git', right: 'project' },
      }),
    );
    const saved = structuredClone(storage.get(layoutKey));
    view.unmount();
    await openWorkspace();
    await waitFor(() => expect(panel('git').dataset.sidebarSide).toBe('left'));
    expect(panel('project').dataset.sidebarSide).toBe('right');
    expect(visible(panel('project'))).toBe(true);
    expect(visible(panel('git'))).toBe(true);
    expect(storage.get(layoutKey)).toEqual(saved);
  });

  it('moves a dirty database panel without remounting, but guards a switch that hides it', async () => {
    await openWorkspace();
    fireEvent.click(railButton('right', 'database'));
    vi.mocked(api.toolRequest)
      .mockResolvedValueOnce([{ schema: '', name: 'people', type: 'table' }])
      .mockResolvedValueOnce({
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
          { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
        ],
        rows: [{ id: 1, name: 'Original' }],
        primaryKey: ['id'],
        editable: true,
        offset: 0,
        hasMore: false,
      });
    await screen.findByRole('option', { name: 'Demo · sqlite' });
    fireEvent.change(await screen.findByLabelText('Saved database connection'), {
      target: { value: 'db' },
    });
    await screen.findByRole('option', { name: 'people' });
    fireEvent.change(screen.getByLabelText('Database table'), { target: { value: '.people' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit row 1 name' }));
    const cell = await screen.findByRole('dialog', { name: 'Edit name' });
    fireEvent.change(within(cell).getByRole('textbox'), {
      target: { value: 'Unapplied database value' },
    });
    fireEvent.click(within(cell).getByRole('button', { name: 'Keep edit' }));
    const row = screen.getByRole('button', { name: 'Edit row 1 name' });
    const databaseHost = panel('database');
    await move('Database', 'left');
    expect(panel('database')).toBe(databaseHost);
    expect(databaseHost.dataset.sidebarSide).toBe('left');
    expect(screen.getByRole('button', { name: 'Edit row 1 name' })).toBe(row);
    expect(screen.queryByRole('dialog', { name: 'Discard pending row edits?' })).toBeNull();
    fireEvent.click(railButton('left', 'project'));
    const confirmation = await screen.findByRole('dialog', { name: 'Discard pending row edits?' });
    expect(visible(databaseHost)).toBe(true);
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Keep editing' }));
    expect(row.textContent).toBe('Unapplied database value');
    fireEvent.click(railButton('left', 'project'));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Discard pending row edits?' })).getByRole(
        'button',
        { name: 'Discard and close' },
      ),
    );
    await waitFor(() => expect(visible(databaseHost)).toBe(false));
    expect(screen.getByRole('tab', { name: 'Demo' })).toBeTruthy();
    fireEvent.click(railButton('left', 'database'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Edit row 1 name' }).textContent).toBe('Original'),
    );
    expect(panel('database')).toBe(databaseHost);
    fireEvent.click(railButton('left', 'project'));
    expect(visible(panel('project'))).toBe(true);
  });
});

it('opens Find in the chosen project folder and reuses the open panel with query focus', async () => {
  await openWorkspace();
  vi.mocked(api.search).mockResolvedValue([]);
  const folder = screen.getByRole('treeitem', { name: 'folder' });
  fireEvent.contextMenu(folder);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Find in folder…' }));
  const query = await screen.findByRole('textbox', { name: 'Search text in workspace' });
  expect(
    (screen.getByRole('combobox', { name: 'Directory / module' }) as HTMLInputElement).value,
  ).toBe('folder');
  expect(document.activeElement).toBe(query);
  fireEvent.change(query, { target: { value: 'needle' } });
  fireEvent.click(screen.getByRole('button', { name: /^Find$/ }));
  await waitFor(() => expect(api.search).toHaveBeenCalledWith('needle', 'folder'));
  fireEvent.click(screen.getByRole('button', { name: 'Search whole workspace' }));
  fireEvent.keyDown(folder, { key: 'F10', shiftKey: true });
  fireEvent.click(screen.getByRole('menuitem', { name: 'Find in folder…' }));
  expect(
    (screen.getByRole('combobox', { name: 'Directory / module' }) as HTMLInputElement).value,
  ).toBe('folder');
  expect((query as HTMLInputElement).value).toBe('needle');
  expect(document.activeElement).toBe(query);
});

it('Cmd+Shift+K opens outgoing diffs with Git closed and pushes only after confirmation', async () => {
  await openWorkspace();
  vi.mocked(api.pushPlan).mockResolvedValue({
    fingerprint: 'reviewed-push',
    remote: 'origin',
    branch: 'main',
    upstream: 'origin/main',
    commits: [{ id: 'abc12345', subject: 'Change', author: 'Author' }],
    files: ['file.txt'],
    filePatches: { 'file.txt': '-before\n+after' },
    diff: '-before\n+after',
  });
  let finishPush!: (message: string) => void;
  vi.mocked(api.push).mockImplementation(
    () =>
      new Promise((resolve) => {
        finishPush = resolve;
      }),
  );
  const editorInput = document.createElement('textarea');
  document.body.append(editorInput);
  const childKey = vi.fn((event: KeyboardEvent) => event.preventDefault());
  editorInput.addEventListener('keydown', childKey);
  const shortcut = () =>
    fireEvent.keyDown(window, { key: 'K', code: 'KeyK', metaKey: true, shiftKey: true });
  fireEvent.keyDown(editorInput, { key: 'K', code: 'KeyK', metaKey: true, shiftKey: true });
  expect(childKey).not.toHaveBeenCalled();
  editorInput.remove();
  let dialog = within(await screen.findByRole('dialog', { name: 'Push Commits' }));
  await dialog.findByRole('region', { name: 'Code changes' });
  expect(dialog.getByRole('region', { name: 'Code changes' }).textContent).toContain('+after');
  expect(api.push).not.toHaveBeenCalled();
  shortcut();
  expect(api.pushPlan).toHaveBeenCalledTimes(1);
  fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
  expect(api.push).not.toHaveBeenCalled();
  shortcut();
  dialog = within(await screen.findByRole('dialog', { name: 'Push Commits' }));
  const accept = await dialog.findByRole('button', { name: 'Push 1 commit' });
  fireEvent.click(accept);
  fireEvent.click(accept);
  await waitFor(() => expect(api.push).toHaveBeenCalledTimes(1));
  expect(api.push).toHaveBeenCalledWith('reviewed-push');
  expect(screen.queryByRole('dialog', { name: 'Push Commits' })).toBeNull();
  expect(screen.getByText("Pushing 'main'…")).toBeTruthy();
  shortcut();
  expect(screen.queryByRole('dialog', { name: 'Push Commits' })).toBeNull();
  expect(api.pushPlan).toHaveBeenCalledTimes(2);
  const filter = screen.getByLabelText('Filter project files');
  fireEvent.change(filter, { target: { value: 'file' } });
  expect((filter as HTMLInputElement).value).toBe('file');
  await act(async () => finishPush('Push complete'));
  expect(screen.getByText("Branch 'main' pushed.")).toBeTruthy();
});

it('Cmd+T opens Update Project with Git closed and updates only after confirmation', async () => {
  await openWorkspace();
  const input = document.createElement('textarea');
  document.body.append(input);
  const editorKey = vi.fn((event: KeyboardEvent) => event.preventDefault());
  input.addEventListener('keydown', editorKey);
  fireEvent.keyDown(input, { key: 't', code: 'KeyT', metaKey: true });
  expect(editorKey).not.toHaveBeenCalled();
  input.remove();
  const dialog = within(await screen.findByRole('dialog', { name: 'Update Project' }));
  await dialog.findByRole('radio', { name: 'Merge incoming changes into the current branch' });
  expect(panels.gitMounts).toBe(0);
  expect(vi.mocked(request).mock.calls.some(([method]) => method === 'git.pull')).toBe(false);
  fireEvent.keyDown(window, { key: 't', code: 'KeyT', metaKey: true });
  expect(screen.getAllByRole('dialog', { name: 'Update Project' })).toHaveLength(1);
  fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
  expect(vi.mocked(request).mock.calls.some(([method]) => method === 'git.pull')).toBe(false);
  fireEvent.keyDown(window, { key: 't', code: 'KeyT', metaKey: true });
  const reopened = within(await screen.findByRole('dialog', { name: 'Update Project' }));
  await reopened.findByRole('radio', { name: 'Merge incoming changes into the current branch' });
  vi.mocked(request).mockImplementation(async () => ({
    snapshot: { branch: 'main' },
    output: '',
    conflicts: [],
  }));
  fireEvent.click(reopened.getByRole('button', { name: 'OK' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('git.pull', { fingerprint: 'repo', strategy: 'merge' }),
  );
  expect(screen.queryByRole('dialog', { name: 'Update Project' })).toBeNull();
});
