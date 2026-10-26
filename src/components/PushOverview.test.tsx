// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PushOverview } from './PushOverview';
import { DiffActionsContext } from './DiffActions';
import { request } from '../api';
import type { GitDiff, PushPlan } from '../contracts';
vi.mock('../api', () => ({ request: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const diff: GitDiff = {
  path: 'file.txt',
  before: 'old\n',
  after: 'new\n',
  base: 'base-oid',
  revision: 'head-oid',
  patch: '',
  binary: false,
  fingerprint: 'reviewed',
  kind: 'text',
  partialAllowed: true,
  hunks: [
    {
      id: 'h',
      oldStart: 1,
      newStart: 1,
      lines: [
        { id: 'remove', kind: 'remove', text: 'old', oldLine: 1 },
        { id: 'add', kind: 'add', text: 'new', newLine: 1 },
      ],
    },
  ],
};
const plan: PushPlan = {
  base: 'base-oid',
  head: 'head-oid',
  fingerprint: 'push',
  remote: 'origin',
  branch: 'main',
  upstream: 'origin/main',
  commits: [],
  files: ['file.txt'],
  diff: '-old\n+new',
  filePatches: { 'file.txt': '-old\n+new' },
};
it('reviews immutable outgoing commits and exposes hunk revert and highlighted editing', async () => {
  vi.mocked(request).mockResolvedValue(diff);
  const edit = vi.fn(async () => {});
  const close = vi.fn();
  const revert = vi.fn(async () => {});
  render(
    <DiffActionsContext.Provider value={{ edit, revert }}>
      <PushOverview plan={plan} onEdit={close} />
    </DiffActionsContext.Provider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'file.txt' }));
  await screen.findByRole('button', { name: 'Revert file…' });
  expect(request).toHaveBeenCalledWith('git.compareFile', {
    branch: 'base-oid',
    revision: 'head-oid',
    path: 'file.txt',
  });
  fireEvent.click(screen.getByRole('button', { name: 'Revert hunk at line 1…' }));
  expect(screen.getByRole('alertdialog').textContent).toContain('commits stay intact');
  fireEvent.click(screen.getByRole('button', { name: 'Revert changes' }));
  await waitFor(() => expect(revert).toHaveBeenCalledWith(diff, ['remove', 'add']));
  await screen.findByRole('button', { name: 'Edit file' });
  fireEvent.click(screen.getByRole('button', { name: 'Edit file' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(edit).toHaveBeenCalledWith(diff);
});
