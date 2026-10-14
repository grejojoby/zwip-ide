// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { api } from './api';
import { open } from '@tauri-apps/plugin-dialog';
import type { OpenEditor } from './editor/editor-store';
import type { WorkspaceSnapshot } from './contracts';
import { updates } from './content/updates';

const panels = vi.hoisted(() => ({
  editors: new Map<string, OpenEditor>(),
  gitMounts: 0,
  databaseMounts: 0,
  databaseUnmounts: 0,
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
vi.mock('./components/tools/DatabasePanel', async () => {
  const { useState, useEffect } = await import('react');
  return {
    DatabasePanel: ({ onDirty }: { onDirty(dirty: boolean): void }) => {
      const [draft, setDraft] = useState(() => {
        panels.databaseMounts++;
        return '';
      });
      useEffect(
        () => () => {
          panels.databaseUnmounts++;
          onDirty(false);
        },
        [onDirty],
      );
      return (
        <section aria-label="Database tools">
          <input
            aria-label="Pending database row"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              onDirty(true);
            }}
          />
        </section>
      );
    },
  };
});
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('./api', () => ({
  request: vi.fn(),
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
    workspaceStatus: vi.fn(),
    workspaceChanges: vi.fn(),
    cancelNavigation: vi.fn(),
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
  panels.gitMounts = panels.databaseMounts = panels.databaseUnmounts = 0;
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
    await screen.findByRole('button', { name: /other-fixture/ });
    await waitFor(() => expect(railButton('right', 'git').disabled).toBe(false));
    storage.set(layoutKey, {
      version: 1,
      placements: { project: 'right', git: 'left', database: 'right', http: 'right' },
      active: { left: 'git', right: 'project' },
    });
    vi.mocked(open).mockResolvedValue(root);
    fireEvent.click(screen.getByRole('button', { name: /other-fixture/ }));
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
    await move('Project', 'right');
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
    const row = await screen.findByLabelText('Pending database row');
    fireEvent.change(row, { target: { value: 'Unapplied database value' } });
    const databaseHost = panel('database');
    await move('Database', 'left');
    expect(panel('database')).toBe(databaseHost);
    expect(databaseHost.dataset.sidebarSide).toBe('left');
    expect(screen.getByLabelText('Pending database row')).toBe(row);
    expect(panels.databaseMounts).toBe(1);
    expect(panels.databaseUnmounts).toBe(0);
    expect(screen.queryByRole('dialog', { name: 'Discard pending row edits?' })).toBeNull();
    fireEvent.click(railButton('left', 'project'));
    const confirmation = await screen.findByRole('dialog', { name: 'Discard pending row edits?' });
    expect(visible(databaseHost)).toBe(true);
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Keep editing' }));
    expect((row as HTMLInputElement).value).toBe('Unapplied database value');
    expect(panels.databaseUnmounts).toBe(0);
    fireEvent.click(railButton('left', 'project'));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Discard pending row edits?' })).getByRole(
        'button',
        { name: 'Discard and close' },
      ),
    );
    await waitFor(() => expect(panels.databaseUnmounts).toBe(1));
    expect(screen.queryByLabelText('Pending database row')).toBeNull();
    expect(visible(panel('project'))).toBe(true);
  });
});
