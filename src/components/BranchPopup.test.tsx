// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BranchPopup } from './BranchPopup';

const calls: { method: string; params: Record<string, unknown> }[] = [];
const branches = [
  { name: 'main', remote: false, current: true, upstream: 'origin/main', subject: 's', oid: '1' },
  { name: 'feature', remote: false, current: false, upstream: '', subject: 's', oid: '2' },
  { name: 'origin/main', remote: true, current: false, subject: 's', oid: '1' },
  { name: 'origin/HEAD', remote: true, current: false, subject: 's', oid: '1' },
  { name: 'origin/topic', remote: true, current: false, subject: 's', oid: '3' },
];
vi.mock('../api', () => ({
  api: {
    gitStatus: async () => ({ root: '/p/demo', branch: 'main', fingerprint: 'fp', files: [] }),
  },
  request: async (method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, params });
    if (method === 'git.branches') return { branches };
    if (method === 'git.compareBranch')
      return {
        current: 'main',
        branch: 'feature',
        mode: 'branch',
        files: [{ status: 'A', path: 'x.txt' }],
        incoming: [{ id: 'a', subject: 'one' }],
        outgoing: [],
      };
    return { snapshot: { branch: 'feature' }, output: 'Switched', conflicts: [] };
  },
}));
beforeEach(() => {
  calls.length = 0;
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
});
afterEach(cleanup);

async function open(onChanged = vi.fn()) {
  render(<BranchPopup onClose={() => {}} onChanged={onChanged} />);
  await screen.findByText('Local Branches');
  return onChanged;
}

describe('branch popup', () => {
  it('lists local and remote branches, hides origin/HEAD and filters by name', async () => {
    await open();
    expect(screen.getAllByRole('option')).toHaveLength(5);
    expect(screen.queryByText('origin/HEAD')).toBeNull();
    fireEvent.change(screen.getByLabelText('Filter branches'), { target: { value: 'top' } });
    expect(screen.getByText('origin/topic')).toBeTruthy();
    expect(screen.queryByText('feature')).toBeNull();
  });
  it('checks out a branch from its action menu using the reviewed fingerprint', async () => {
    const onChanged = await open();
    fireEvent.click(screen.getByText('feature'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Checkout' }));
    await waitFor(() =>
      expect(onChanged).toHaveBeenCalledWith({
        branch: 'feature',
        message: 'Switched',
        conflicts: false,
      }),
    );
    expect(calls.at(-1)).toEqual({
      method: 'git.switchBranch',
      params: { fingerprint: 'fp', branch: 'feature', remote: false },
    });
  });
  it('checks out remote branches as tracking branches and offers no delete for them', async () => {
    await open();
    fireEvent.click(screen.getByText('origin/topic'));
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Checkout' }));
    await waitFor(() =>
      expect(calls.at(-1)?.params).toMatchObject({ branch: 'origin/topic', remote: true }),
    );
  });
  it('requires confirmation before merging and labels it with both branches', async () => {
    await open();
    fireEvent.click(screen.getByText('feature'));
    fireEvent.click(screen.getByRole('menuitem', { name: "Merge 'feature' into 'main'" }));
    expect(calls.some((call) => call.method === 'git.merge')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    await waitFor(() =>
      expect(calls.at(-1)).toMatchObject({ method: 'git.merge', params: { ref: 'feature' } }),
    );
  });
  it('shows a comparison with the current branch', async () => {
    await open();
    fireEvent.click(screen.getByText('feature'));
    fireEvent.click(screen.getByRole('menuitem', { name: "Compare with 'main'" }));
    expect(await screen.findByText('x.txt')).toBeTruthy();
    expect(screen.getByText(/1 commit only in feature/)).toBeTruthy();
  });
  it('creates a new branch from the first row', async () => {
    await open();
    fireEvent.click(screen.getByRole('option', { name: '+ New Branch' }));
    fireEvent.change(screen.getByLabelText('Branch name'), { target: { value: 'topic-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() =>
      expect(calls.at(-1)).toMatchObject({
        method: 'git.createBranch',
        params: { name: 'topic-2' },
      }),
    );
  });
});
