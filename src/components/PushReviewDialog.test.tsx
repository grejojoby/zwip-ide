// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render as renderView, screen, waitFor } from '@testing-library/react';
import { api } from '../api';
import type { PushPlan } from '../contracts';
import { PushReviewDialog } from './PushReviewDialog';
import { GitActivityProvider } from './GitActivity';
import { useState } from 'react';
const render = (ui: Parameters<typeof renderView>[0]) =>
  renderView(ui, { wrapper: GitActivityProvider });
vi.mock('../api', () => ({ api: { pushPlan: vi.fn(), push: vi.fn() } }));
vi.mock('./PushOverview', () => ({
  PushOverview: ({ plan }: { plan: PushPlan }) => (
    <section aria-label="Code changes">{plan.fingerprint}</section>
  ),
}));
const plan: PushPlan = {
  fingerprint: 'reviewed',
  remote: 'origin',
  branch: 'main',
  upstream: 'origin/main',
  commits: [{ id: 'abc', subject: 'Change', author: 'Author' }],
  files: ['file.txt'],
  filePatches: { 'file.txt': '+change' },
  diff: '+change',
};
beforeEach(() => {
  vi.resetAllMocks();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  vi.mocked(api.pushPlan).mockResolvedValue(plan);
  vi.mocked(api.push).mockResolvedValue('Pushed');
});
afterEach(cleanup);
it('closes immediately and requires a fresh review after a background push fails', async () => {
  const close = vi.fn();
  const completed = vi.fn();
  vi.mocked(api.push).mockRejectedValueOnce(new Error('Push review is stale'));
  function Review() {
    const [open, setOpen] = useState(true);
    return open ? (
      <PushReviewDialog
        onClose={() => {
          close();
          setOpen(false);
        }}
        onPushed={completed}
      />
    ) : (
      <button onClick={() => setOpen(true)}>Review push</button>
    );
  }
  render(<Review />);
  fireEvent.click(await screen.findByRole('button', { name: 'Push 1 commit' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(close).toHaveBeenCalledOnce();
  expect((await screen.findByRole('alert')).textContent).toContain('stale');
  expect(completed).not.toHaveBeenCalled();
  vi.mocked(api.pushPlan).mockResolvedValue({ ...plan, fingerprint: 'refreshed' });
  fireEvent.click(screen.getByRole('button', { name: 'Review push' }));
  await screen.findByText('refreshed');
  expect(api.push).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Push 1 commit' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(completed).toHaveBeenCalledWith('Pushed'));
  expect(api.push).toHaveBeenLastCalledWith('refreshed');
  expect(close).toHaveBeenCalledTimes(2);
});
it('offers retry if loading fails and disables push when nothing is outgoing', async () => {
  vi.mocked(api.pushPlan).mockRejectedValueOnce(new Error('Fetch and review again'));
  render(<PushReviewDialog onClose={vi.fn()} onPushed={vi.fn()} />);
  await screen.findByRole('alert');
  expect((screen.getByRole('button', { name: 'Push' }) as HTMLButtonElement).disabled).toBe(true);
  vi.mocked(api.pushPlan).mockResolvedValue({ ...plan, commits: [] });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh review' }));
  const push = await screen.findByRole('button', { name: 'Push 0 commits' });
  expect((push as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(push);
  expect(api.push).not.toHaveBeenCalled();
});
