// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render as renderView,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { GitOperations } from './GitOperations';
import { BranchPopup } from './BranchPopup';
import type { GitBranch } from '../contracts';

import { GitActivityProvider } from './GitActivity';
const render = (ui: Parameters<typeof renderView>[0]) =>
  renderView(ui, { wrapper: GitActivityProvider });

const { status, mutation, operation } = vi.hoisted(() => ({
  status: vi.fn(),
  mutation: vi.fn(),
  operation: vi.fn(),
}));
const calls: { method: string; params: Record<string, unknown> }[] = [];
const branches: GitBranch[] = [
  {
    name: 'main',
    remote: false,
    current: true,
    upstream: 'origin/main',
    subject: 's',
    oid: '1',
    behind: 2,
    ahead: 1,
  },
  { name: 'feature', remote: false, current: false, upstream: '', subject: 's', oid: '2' },
  { name: 'origin/main', remote: true, current: false, subject: 's', oid: '1' },
  { name: 'origin/HEAD', remote: true, current: false, subject: 's', oid: '1' },
  { name: 'origin/topic', remote: true, current: false, subject: 's', oid: '3' },
];
vi.mock('../api', () => ({
  api: {
    gitStatus: status,
  },
  request: async (method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, params });
    if (method === 'git.operationState') return operation();
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
    return mutation(method, params);
  },
}));
beforeEach(() => {
  calls.length = 0;
  status
    .mockReset()
    .mockResolvedValue({ root: '/p/demo', branch: 'main', fingerprint: 'fp', files: [] });
  operation.mockReset().mockResolvedValue({ operation: 'none', conflicts: [], fingerprint: 'fp' });
  mutation
    .mockReset()
    .mockResolvedValue({ snapshot: { branch: 'feature' }, output: 'Switched', conflicts: [] });
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
  it('moves between branches with the arrow keys as soon as it opens', async () => {
    await open();
    const user = userEvent.setup();
    const list = screen.getByRole('listbox', { name: 'Branches' });
    const filter = screen.getByLabelText('Filter branches');
    expect(document.activeElement).toBe(list);
    expect(document.activeElement).not.toBe(filter);
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(screen.getByRole('option', { selected: true }).textContent).toContain('feature');
    expect(list.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { selected: true }).id,
    );
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('option', { selected: true }).textContent).toContain('main');
    expect(document.activeElement).toBe(list);
  });
  it('opens actions in a side menu beside the branch list and closes it with ArrowLeft', async () => {
    await open();
    const filter = screen.getByLabelText('Filter branches');
    fireEvent.keyDown(filter, { key: 'ArrowDown' });
    fireEvent.keyDown(filter, { key: 'ArrowDown' });
    fireEvent.keyDown(filter, { key: 'ArrowRight' });
    const menu = screen.getByRole('menu', { name: 'Actions for feature' });
    // It flies out beside the dialog with fixed coordinates rather than taking a column inside it.
    expect(menu.style.visibility).not.toBe('hidden');
    expect(menu.style.left).toMatch(/px$/);
    expect(menu.style.top).toMatch(/px$/);
    // The branch list stays visible next to the side menu.
    expect(screen.getAllByRole('option')).toHaveLength(5);
    expect(document.querySelector('[data-expanded]')?.textContent).toContain('feature');
    fireEvent.keyDown(filter, { key: 'ArrowDown' });
    expect(screen.getAllByRole('menuitem')[1].className).toBe('selected');
    fireEvent.keyDown(filter, { key: 'ArrowLeft' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('listbox', { name: 'Branches' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Create and switch' }));
    await waitFor(() =>
      expect(calls.at(-1)).toMatchObject({
        method: 'git.createBranch',
        params: { name: 'topic-2' },
      }),
    );
  });
});

it('shows incoming changes next to a branch and summarizes branches with updates in the modal', async () => {
  await open();
  expect(screen.getByRole('img', { name: '2 incoming commits from origin/main' })).toBeTruthy();
  expect(screen.getByText('1 branch has incoming changes')).toBeTruthy();
});
it('updates branch badges in an open modal and keeps cached counts visible after a fetch failure', async () => {
  const incoming = [{ ...branches[0], behind: 2 }];
  const remote = {
    root: '/p/demo',
    current: 'main',
    branches: incoming,
    fetch: {
      state: 'failed' as const,
      lastFetched: 1,
      error: 'Could not fetch origin; showing last fetched refs.',
      version: 1,
    },
  };
  const { rerender } = render(
    <BranchPopup
      onClose={() => {}}
      onChanged={() => {}}
      remoteStatus={remote}
      onFetch={() => {}}
    />,
  );
  expect(
    await screen.findByRole('img', { name: '2 incoming commits from origin/main' }),
  ).toBeTruthy();
  expect(screen.getByText(/Could not fetch origin/)).toBeTruthy();
  rerender(
    <BranchPopup
      onClose={() => {}}
      onChanged={() => {}}
      remoteStatus={{
        ...remote,
        branches: [{ ...incoming[0], behind: 0 }],
        fetch: { ...remote.fetch, state: 'ready', error: null, version: 2 },
      }}
    />,
  );
  await waitFor(() =>
    expect(screen.queryByRole('img', { name: '2 incoming commits from origin/main' })).toBeNull(),
  );
  await waitFor(() => expect(screen.queryByText(/has incoming changes/)).toBeNull());
});

describe('branch workflow recovery and safety', () => {
  it('shows outgoing commits and explains a diverged current branch', async () => {
    await open();
    expect(screen.getByRole('img', { name: '1 outgoing commit to origin/main' })).toBeTruthy();
    expect(screen.getByText(/Branches have diverged/)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Pull (fast-forward)' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(screen.getByRole('button', { name: 'Push…' }).hasAttribute('disabled')).toBe(true);
  });
  it('keeps a failed branch name available to correct and retry', async () => {
    mutation.mockRejectedValueOnce(new Error('Invalid branch name'));
    await open();
    fireEvent.click(screen.getByRole('option', { name: '+ New Branch' }));
    const input = screen.getByLabelText('Branch name');
    fireEvent.change(input, { target: { value: 'bad..name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create and switch' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Invalid branch name');
    expect(screen.getByLabelText('Branch name')).toHaveProperty('value', 'bad..name');
    fireEvent.change(screen.getByLabelText('Branch name'), { target: { value: 'valid-name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create and switch' }));
    await waitFor(() => expect(mutation).toHaveBeenCalledTimes(2));
  });
  it('refreshes stale review explicitly without automatically replaying a mutation', async () => {
    mutation.mockRejectedValueOnce(new Error('Repository changed; review the operation again'));
    await open();
    fireEvent.click(screen.getByText('feature'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Checkout' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    status.mockResolvedValue({ root: '/p/demo', branch: 'main', fingerprint: 'new-fp', files: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh branches' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(mutation).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('feature'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Checkout' }));
    await waitFor(() => expect(mutation).toHaveBeenCalledTimes(2));
    expect(calls.at(-1)?.params.fingerprint).toBe('new-fp');
  });
  it('does not allow a form to submit twice while a request is pending', async () => {
    let finish!: (value: unknown) => void;
    mutation.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await open();
    fireEvent.click(screen.getByRole('option', { name: '+ New Branch' }));
    fireEvent.change(screen.getByLabelText('Branch name'), { target: { value: 'topic' } });
    const form = screen.getByLabelText('Branch name').closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toMatch(/Creating branch/);
    await act(async () =>
      finish({ snapshot: { branch: 'topic' }, output: 'Created', conflicts: [] }),
    );
  });
  it('lets toolbar buttons receive Enter without opening a branch action', async () => {
    await open();
    const refresh = screen.getByRole('button', { name: 'Refresh branches' });
    refresh.focus();
    fireEvent.keyDown(refresh, { key: 'Enter' });
    expect(screen.queryByLabelText('Branch name')).toBeNull();
  });
  it('offers a retry after initial loading fails', async () => {
    status.mockRejectedValueOnce(new Error('Repository temporarily unavailable'));
    await open();
    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh branches' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByRole('option', { name: '+ New Branch' }).hasAttribute('disabled')).toBe(
      false,
    );
  });
  it('routes unfinished integration to the Git panel', async () => {
    operation.mockResolvedValue({ operation: 'merge', conflicts: ['x.txt'], fingerprint: 'fp' });
    const onOpenGit = vi.fn();
    render(<BranchPopup onClose={() => {}} onChanged={() => {}} onOpenGit={onOpenGit} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Resolve in Git panel' }));
    expect(onOpenGit).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText('feature'));
    expect(
      within(screen.getByRole('menu'))
        .getByRole('menuitem', { name: 'Checkout' })
        .hasAttribute('disabled'),
    ).toBe(true);
  });
});

const remoteStatus = (items = branches) => ({
  root: '/p/demo',
  current: 'main',
  branches: items,
  fetch: { state: 'ready' as const, version: 1, lastFetched: 1, error: null },
});
it('pulls the current branch only after confirming the branch and upstream', async () => {
  render(
    <BranchPopup
      onClose={() => {}}
      onChanged={() => {}}
      remoteStatus={remoteStatus([{ ...branches[0], ahead: 0 }])}
    />,
  );
  const pull = await screen.findByRole('button', { name: 'Pull (fast-forward)' });
  await waitFor(() => expect(pull.hasAttribute('disabled')).toBe(false));
  fireEvent.click(pull);
  expect(screen.getByText(/Fast-forwards 'main' from origin\/main/)).toBeTruthy();
  expect(mutation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Pull (fast-forward)' }));
  await waitFor(() =>
    expect(calls.at(-1)).toEqual({
      method: 'git.updateBranch',
      params: { branch: 'main', fingerprint: 'fp' },
    }),
  );
});
it('preserves the reviewed fingerprint if a fetch finishes during merge confirmation', async () => {
  const props = { onClose: () => {}, onChanged: () => {} };
  const { rerender } = render(<BranchPopup {...props} remoteStatus={remoteStatus()} />);
  await screen.findByText('Local Branches');
  await waitFor(() =>
    expect(screen.getByRole('option', { name: '+ New Branch' }).hasAttribute('disabled')).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByText('feature'));
  fireEvent.click(screen.getByRole('menuitem', { name: "Merge 'feature' into 'main'" }));
  status.mockResolvedValue({
    root: '/p/demo',
    branch: 'main',
    fingerprint: 'after-fetch',
    files: [],
  });
  rerender(
    <BranchPopup
      {...props}
      remoteStatus={{ ...remoteStatus(), fetch: { ...remoteStatus().fetch, version: 2 } }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
  await waitFor(() => expect(calls.at(-1)?.params.fingerprint).toBe('fp'));
});
it('switches to an existing tracking branch when choosing a remote branch', async () => {
  render(
    <BranchPopup
      onClose={() => {}}
      onChanged={() => {}}
      remoteStatus={remoteStatus([
        branches[0],
        { ...branches[1], name: 'local-topic', upstream: 'origin/topic' },
        branches[4],
      ])}
    />,
  );
  await screen.findByText('Local Branches');
  await waitFor(() =>
    expect(screen.getByRole('option', { name: '+ New Branch' }).hasAttribute('disabled')).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByText('origin/topic', { selector: 'button > span:first-child' }));
  fireEvent.click(screen.getByRole('menuitem', { name: "Checkout 'local-topic'" }));
  await waitFor(() =>
    expect(calls.at(-1)?.params).toMatchObject({ branch: 'local-topic', remote: false }),
  );
});
it('keeps branch browsing available and blocks mutations during a background fetch', async () => {
  const remote = remoteStatus();
  render(
    <BranchPopup
      onClose={() => {}}
      onChanged={() => {}}
      remoteStatus={{ ...remote, fetch: { ...remote.fetch, state: 'fetching' } }}
      onFetch={() => {}}
    />,
  );
  await screen.findByText('Local Branches');
  await waitFor(() => expect(screen.queryByText('Loading branches…')).toBeNull());
  fireEvent.click(screen.getByText('feature'));
  expect(screen.getByRole('menuitem', { name: 'Checkout' }).hasAttribute('disabled')).toBe(true);
  expect(
    screen.getByRole('menuitem', { name: "Compare with 'main'" }).hasAttribute('disabled'),
  ).toBe(false);
  expect(screen.getByRole('button', { name: 'Fetching…' }).hasAttribute('disabled')).toBe(true);
});
it('closes for fetch and reports failure outside the dialog, allowing a fresh retry', async () => {
  const onFetch = vi
    .fn()
    .mockRejectedValueOnce(new Error('Transport failed'))
    .mockResolvedValue(undefined);
  function Branches() {
    const [open, setOpen] = useState(true);
    return open ? (
      <BranchPopup
        onClose={() => setOpen(false)}
        onChanged={() => {}}
        remoteStatus={remoteStatus()}
        onFetch={onFetch}
      />
    ) : (
      <button onClick={() => setOpen(true)}>Branches</button>
    );
  }
  render(<Branches />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Fetch origin' }).hasAttribute('disabled')).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Fetch origin' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect((await screen.findByRole('alert')).textContent).toContain('Transport failed');
  fireEvent.click(screen.getByRole('button', { name: 'Branches' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Fetch origin' }).hasAttribute('disabled')).toBe(
      false,
    ),
  );
  expect(screen.getByText('feature')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Fetch origin' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(onFetch).toHaveBeenCalledTimes(2));
});
it('offers merge and rebase from the current branch when its upstream has diverged', async () => {
  await open();
  fireEvent.click(screen.getByText('★ main'));
  const merge = screen.getByRole('menuitem', { name: "Merge 'origin/main' into 'main'" });
  expect(merge.hasAttribute('disabled')).toBe(false);
  expect(screen.getByRole('menuitem', { name: "Rebase 'main' onto 'origin/main'" })).toBeTruthy();
  fireEvent.click(merge);
  expect(
    screen.getByText("'origin/main' is merged into the checked-out branch 'main'."),
  ).toBeTruthy();
});

it('opens the shared branch menu from the Git panel', async () => {
  const onOpenBranches = vi.fn();
  render(
    <GitOperations
      snapshot={{ root: '/p/demo', branch: 'main', head: '1', fingerprint: 'fp', files: [] }}
      onUpdate={() => {}}
      onOpenBranches={onOpenBranches}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Branches…' }));
  expect(onOpenBranches).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('disables panel fetch and pull while the background fetch is running', async () => {
  const remote = remoteStatus();
  render(
    <GitOperations
      snapshot={{ root: '/p/demo', branch: 'main', head: '1', fingerprint: 'fp', files: [] }}
      onUpdate={() => {}}
      remoteStatus={{ ...remote, fetch: { ...remote.fetch, state: 'fetching' } }}
    />,
  );
  await act(async () => {});
  expect(screen.getByRole('button', { name: 'Fetch' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'Pull (fast-forward)' }).hasAttribute('disabled')).toBe(
    true,
  );
});

it('starts searching when typing from the focused branch list and still navigates matches', async () => {
  const user = userEvent.setup();
  await open();
  await user.keyboard('top');
  const filter = screen.getByLabelText('Filter branches');
  expect(document.activeElement).toBe(filter);
  expect(filter).toHaveProperty('value', 'top');
  expect(screen.queryByText('feature')).toBeNull();
  await user.keyboard('{ArrowDown}{Enter}');
  expect(screen.getByRole('menu', { name: 'Actions for origin/topic' })).toBeTruthy();
  await user.keyboard('{ArrowLeft}');
  expect(document.activeElement).toBe(screen.getByRole('listbox', { name: 'Branches' }));
});

it.each(['update', 'push'] as const)(
  'closes the confirmation immediately during a branch %s and reports completion later',
  async (kind) => {
    let finish!: (result: unknown) => void;
    mutation.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const changed = vi.fn();
    function Branches() {
      const [open, setOpen] = useState(true);
      return (
        open && (
          <BranchPopup
            onClose={() => setOpen(false)}
            onChanged={changed}
            remoteStatus={remoteStatus([
              { ...branches[0], ahead: 0 },
              { ...branches[1], upstream: 'origin/feature', ahead: 1, behind: 0 },
            ])}
          />
        )
      );
    }
    render(<Branches />);
    await screen.findByText('Local Branches');
    fireEvent.click(screen.getByText('feature', { selector: 'button > span:first-child' }));
    fireEvent.click(
      screen.getByRole('menuitem', {
        name: kind === 'update' ? 'Update (fast-forward)…' : 'Push…',
      }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: kind === 'update' ? 'Update branch' : 'Push' }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain(
      kind === 'update' ? "Updating 'feature'" : "Pushing 'feature'",
    );
    await waitFor(() => expect(mutation).toHaveBeenCalledOnce());
    expect(changed).not.toHaveBeenCalled();
    await act(async () => finish({ snapshot: { branch: 'main' }, output: 'Done', conflicts: [] }));
    expect(screen.getByRole('status').textContent).toContain(
      kind === 'update' ? "Branch 'feature' updated." : "Branch 'feature' pushed.",
    );
    expect(changed).toHaveBeenCalledOnce();
  },
);
