// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { GitPanel, type Selection } from './GitPanel';

const settings = new Map<string, unknown>();
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
      files: repository.paths.map((path) => ({ path, indexStatus: ' ', worktreeStatus: 'M' })),
    }),
    changelists: async () => [],
    gitConflicts: async () => [],
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: unknown) => settings.set(key, value),
  },
  request: vi.fn(async () => []),
}));
vi.mock('./GitOperations', () => ({ GitOperations: () => null }));
afterEach(cleanup);

function Harness() {
  const [selected, setSelected] = useState(new Map<string, Selection>());
  return (
    <GitPanel
      generation={1}
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
