// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DiffActions, DiffActionsContext } from './DiffActions';
import { request } from '../api';
import type { GitDiff } from '../contracts';
vi.mock('../api', () => ({ request: vi.fn(async () => ({})) }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const diff: GitDiff = {
  path: 'file.txt',
  before: 'old\n',
  after: 'new\n',
  patch: '',
  binary: false,
  fingerprint: 'reviewed',
  kind: 'text',
  partialAllowed: true,
  hunks: [],
};
it('requires confirmation and sends only the reviewed hunk IDs and version', async () => {
  const refreshed = vi.fn();
  render(<DiffActions diff={diff} changeIds={['remove', 'add']} onReverted={refreshed} />);
  fireEvent.click(screen.getByRole('button', { name: 'Revert hunk…' }));
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Revert hunk…' }));
  fireEvent.click(screen.getByRole('button', { name: 'Revert changes' }));
  await waitFor(() => expect(refreshed).toHaveBeenCalledOnce());
  expect(request).toHaveBeenCalledWith(
    'git.revertDiff',
    expect.objectContaining({
      path: 'file.txt',
      fingerprint: 'reviewed',
      changeIds: ['remove', 'add'],
    }),
  );
});
it('keeps a failed revert visible without reporting a refresh', async () => {
  const refreshed = vi.fn();
  vi.mocked(request).mockRejectedValueOnce(new Error('Diff is stale; refresh and review again'));
  render(<DiffActions diff={diff} onReverted={refreshed} />);
  fireEvent.click(screen.getByRole('button', { name: 'Revert file…' }));
  fireEvent.click(screen.getByRole('button', { name: 'Revert changes' }));
  expect((await screen.findByRole('alert')).textContent).toContain('stale');
  expect(refreshed).not.toHaveBeenCalled();
});
it('opens the reviewed file in the highlighted editor and dismisses the enclosing review', async () => {
  const edit = vi.fn(async () => {});
  const close = vi.fn();
  render(
    <DiffActionsContext.Provider value={{ edit }}>
      <DiffActions diff={diff} onEdit={close} />
    </DiffActionsContext.Provider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Edit file' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(edit).toHaveBeenCalledWith(diff);
});
it('disables destructive actions for special files', () => {
  render(<DiffActions diff={{ ...diff, binary: true, kind: 'binary', partialAllowed: false }} />);
  expect((screen.getByRole('button', { name: 'Revert file…' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});
