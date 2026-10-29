// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render as renderView,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../api';
import type { Changelist } from '../contracts';
import { GitPanel, type Selection } from './GitPanel';

import { GitActivityProvider } from './GitActivity';
const render = (ui: Parameters<typeof renderView>[0]) =>
  renderView(ui, { wrapper: GitActivityProvider });

const settings = new Map<string, unknown>();
const changes = {
  statuses: {} as Record<string, string>,
  conflicts: [] as string[],
  lists: [] as Changelist[],
};
const repository = {
  fingerprint: 'f1',
  paths: ['renderly/app/cmd/app.go', 'renderly/app/pkg/fetch.go', 'README.md'],
};
vi.mock('../api', () => ({
  api: {
    gitStatus: async () => ({
      root: '/repo',
      branch: 'main',
      fingerprint: repository.fingerprint,
      files: repository.paths.map((path) => ({
        path,
        indexStatus: ' ',
        worktreeStatus: changes.statuses[path] ?? 'M',
      })),
    }),
    pushPlan: async () => ({
      fingerprint: 'push1',
      remote: 'origin',
      branch: 'main',
      upstream: 'origin/main',
      commits: [{ id: 'abc12345', subject: 'Update app', author: 'Author' }],
      files: ['src/app.ts', 'src/lib/helper.ts', 'README.md'],
      filePatches: {
        'src/app.ts': '+app change',
        'src/lib/helper.ts': '+helper change',
        'README.md': '+readme change',
      },
      diff: '+app change\n+helper change\n+readme change',
    }),
    changelists: async () => changes.lists,
    saveChangelist: vi.fn(async () => changes.lists),
    gitDiff: vi.fn(async (path: string) => ({ path, fingerprint: repository.fingerprint })),
    gitConflicts: async () => changes.conflicts,
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: unknown) => settings.set(key, value),
  },
  request: vi.fn(async () => []),
}));
vi.mock('./GitOperations', () => ({ GitOperations: () => null }));
afterEach(cleanup);
beforeEach(() => {
  settings.clear();
  changes.statuses = {};
  changes.conflicts = [];
  changes.lists = [];
  vi.clearAllMocks();
});

function Harness({ onFileAction = vi.fn(), onOpenFile = vi.fn(), onOpenDiff = vi.fn() } = {}) {
  const [selected, setSelected] = useState(new Map<string, Selection>());
  return (
    <GitPanel
      generation={1}
      onFileAction={onFileAction}
      onOpenFile={onOpenFile}
      onOpenDiff={onOpenDiff}
      onBranch={() => {}}
      selected={selected}
      onSelectedChange={setSelected}
    />
  );
}

it('groups changes by directory and selects a whole directory for commit', async () => {
  render(<Harness />);
  await screen.findByTitle('renderly/app/cmd/app.go');
  fireEvent.click(screen.getByRole('button', { name: /Directories/ }));
  expect(settings.get('zwip.git.groupByDirectory')).toBe(true);
  const folder = screen.getByRole('checkbox', { name: 'Include renderly/app in commit' });
  fireEvent.click(folder);
  await waitFor(() =>
    expect(
      (
        screen.getByRole('checkbox', {
          name: 'Include renderly/app/pkg/fetch.go in commit',
        }) as HTMLInputElement
      ).checked,
    ).toBe(true),
  );
  expect(
    (screen.getByRole('checkbox', { name: 'Include README.md in commit' }) as HTMLInputElement)
      .checked,
  ).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: /renderly\/app/ }));
  expect(screen.queryByTitle('renderly/app/cmd/app.go')).toBeNull();
  // ⌃P switches back to the flat list, as in IntelliJ.
  fireEvent.keyDown(screen.getByRole('region', { name: 'Git changes' }), {
    key: 'p',
    code: 'KeyP',
    ctrlKey: true,
  });
  expect(screen.getByTitle('renderly/app/cmd/app.go').textContent).toContain(
    'renderly/app/cmd/app.go',
  );
});

it('reloads the change list when Git changed outside Zwip and the window regains focus', async () => {
  render(<Harness />);
  await screen.findByTitle('README.md');
  // A commit from a terminal or another IDE leaves only README.md changed.
  Object.assign(repository, { fingerprint: 'f2', paths: ['README.md'] });
  fireEvent.focus(window);
  await waitFor(() => expect(screen.queryByTitle('renderly/app/cmd/app.go')).toBeNull());
  expect(screen.getByTitle('README.md')).toBeTruthy();
  Object.assign(repository, {
    fingerprint: 'f1',
    paths: ['renderly/app/cmd/app.go', 'renderly/app/pkg/fetch.go', 'README.md'],
  });
});

it('shows outgoing commits beside a nested file tree and previews only the selected file below', async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  render(<Harness />);
  await screen.findByTitle('README.md');
  fireEvent.click(screen.getByRole('button', { name: 'Push…' }));
  const dialog = within(await screen.findByRole('dialog', { name: 'Push Commits' }));
  expect(
    (await dialog.findByRole('complementary', { name: 'Outgoing commits' })).textContent,
  ).toContain('Update app');
  expect(await dialog.findByRole('region', { name: 'Code changes' })).toBeTruthy();
  fireEvent.click(dialog.getByRole('button', { name: 'src/app.ts' }));
  let preview = dialog.getByRole('region', { name: 'Code changes' });
  expect(preview.textContent).toContain('+app change');
  expect(preview.textContent).not.toContain('+helper change');
  fireEvent.click(dialog.getByRole('button', { name: 'src/lib/helper.ts' }));
  preview = dialog.getByRole('region', { name: 'Code changes' });
  expect(preview.textContent).toContain('+helper change');
  expect(preview.textContent).not.toContain('+app change');
  fireEvent.click(dialog.getByRole('button', { name: 'src', expanded: true }));
  expect(dialog.queryByRole('button', { name: 'src/app.ts' })).toBeNull();
  fireEvent.click(dialog.getByRole('button', { name: 'src', expanded: false }));
  expect(dialog.getByRole('button', { name: 'src/app.ts' })).toBeTruthy();
});

it('targets the right-clicked change for file actions without opening a diff or changing selection', async () => {
  const onFileAction = vi.fn();
  const onOpenFile = vi.fn();
  render(<Harness onFileAction={onFileAction} onOpenFile={onOpenFile} />);
  const file = await screen.findByTitle('README.md');
  fireEvent.contextMenu(file);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Rename or move…' }));
  expect(onFileAction).toHaveBeenCalledWith('rename', '/repo/README.md', false);
  expect(api.gitDiff).not.toHaveBeenCalled();
  expect(
    (screen.getByRole('checkbox', { name: 'Include README.md in commit' }) as HTMLInputElement)
      .checked,
  ).toBe(false);
  fireEvent.contextMenu(file);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Open file' }));
  expect(onOpenFile).toHaveBeenCalledWith('/repo/README.md');
});

it('offers diff and commit inclusion from the keyboard and restores row focus', async () => {
  const onOpenDiff = vi.fn();
  render(<Harness onOpenDiff={onOpenDiff} />);
  const file = await screen.findByTitle('README.md');
  fireEvent.keyDown(file, { key: 'F10', shiftKey: true });
  fireEvent.click(screen.getByRole('menuitem', { name: 'Include in commit' }));
  expect(
    (screen.getByRole('checkbox', { name: 'Include README.md in commit' }) as HTMLInputElement)
      .checked,
  ).toBe(true);
  fireEvent.contextMenu(file);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Exclude from commit' }));
  fireEvent.contextMenu(file);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Show diff' }));
  await waitFor(() =>
    expect(onOpenDiff).toHaveBeenCalledWith(expect.objectContaining({ path: 'README.md' })),
  );
  fireEvent.contextMenu(file);
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(document.activeElement).toBe(file);
});

it('disables missing-file actions for deletions while preserving diff and path actions', async () => {
  changes.statuses['README.md'] = 'D';
  const onFileAction = vi.fn();
  render(<Harness onFileAction={onFileAction} />);
  fireEvent.contextMenu(await screen.findByTitle('README.md'));
  for (const name of ['Open file', 'Rename or move…', 'Copy file…', 'Delete…', 'Format file'])
    expect((screen.getByRole('menuitem', { name }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('menuitem', { name: 'Show diff' }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  fireEvent.click(screen.getByRole('menuitem', { name: 'Copy relative path' }));
  expect(onFileAction).toHaveBeenCalledWith('copyRelativePath', '/repo/README.md', false);
});

it('offers conflict resolution and prevents editing conflicted files from the menu', async () => {
  changes.conflicts = ['README.md'];
  render(<Harness />);
  fireEvent.contextMenu(await screen.findByTitle('README.md'));
  expect(screen.getByRole('menuitem', { name: 'Resolve conflicts…' })).toBeTruthy();
  for (const name of ['Include in commit', 'Rename or move…', 'Format file'])
    expect((screen.getByRole('menuitem', { name }) as HTMLButtonElement).disabled).toBe(true);
});

it('moves only the context file to a changelist, preserving unrelated commit selections', async () => {
  changes.lists = [{ id: 'work', name: 'Work', paths: [] }];
  render(<Harness />);
  await screen.findByTitle('README.md');
  fireEvent.click(
    screen.getByRole('checkbox', { name: 'Include renderly/app/cmd/app.go in commit' }),
  );
  fireEvent.contextMenu(screen.getByTitle('README.md'));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Move to changelist' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Work' }));
  await waitFor(() =>
    expect(api.saveChangelist).toHaveBeenCalledWith('work', 'Work', ['README.md'], []),
  );
  expect(
    (
      screen.getByRole('checkbox', {
        name: 'Include renderly/app/cmd/app.go in commit',
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
});

it('offers folder actions in directory grouping and includes only that directory in commit', async () => {
  const onFileAction = vi.fn();
  render(<Harness onFileAction={onFileAction} />);
  await screen.findByTitle('README.md');
  fireEvent.click(screen.getByRole('button', { name: /Directories/ }));
  const directory = screen.getByTitle('renderly/app');
  fireEvent.contextMenu(directory);
  expect(screen.queryByRole('menuitem', { name: 'Rename or move…' })).toBeNull();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Copy path' }));
  expect(onFileAction).toHaveBeenCalledWith('copyPath', '/repo/renderly/app', true);
  fireEvent.contextMenu(directory);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Include in commit' }));
  expect(
    (
      screen.getByRole('checkbox', {
        name: 'Include renderly/app/cmd/app.go in commit',
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
  expect(
    (screen.getByRole('checkbox', { name: 'Include README.md in commit' }) as HTMLInputElement)
      .checked,
  ).toBe(false);
});
