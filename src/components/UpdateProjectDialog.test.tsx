// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, request } from '../api';
import { GitActivityProvider } from './GitActivity';
import { UpdateProjectDialog } from './UpdateProjectDialog';
vi.mock('../api', () => ({
  api: { gitStatus: vi.fn(), getSetting: vi.fn(), setSetting: vi.fn() },
  request: vi.fn(),
}));
const snapshot = {
  root: '/project',
  branch: 'main',
  head: 'before',
  fingerprint: 'reviewed',
  files: [],
};
const result = {
  snapshot,
  output: '',
  conflicts: [],
  update: {
    branch: 'main',
    before: 'before',
    after: 'after',
    fileCount: 2,
    commitCount: 1,
    commits: [{ id: 'abc12345', subject: 'Incoming fix', author: 'Author' }],
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  vi.mocked(api.gitStatus).mockResolvedValue(snapshot);
  vi.mocked(api.getSetting).mockResolvedValue(null);
  vi.mocked(api.setSetting).mockResolvedValue(null);
  vi.mocked(request).mockResolvedValue(result);
});
afterEach(cleanup);
function Launcher({ showOptions = false }: { showOptions?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    open && (
      <UpdateProjectDialog
        showOptions={showOptions}
        onClose={() => setOpen(false)}
        onUpdated={vi.fn()}
      />
    )
  );
}
it('reviews merge or rebase, closes during update and shows incoming commit details', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(request).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <GitActivityProvider>
      <Launcher />
    </GitActivityProvider>,
  );
  const merge = await screen.findByRole('radio', {
    name: 'Merge incoming changes into the current branch',
  });
  expect((merge as HTMLInputElement).checked).toBe(true);
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole('radio', { name: 'Rebase the current branch on top of incoming changes' }),
  );
  fireEvent.click(screen.getByRole('checkbox', { name: "Don't show again" }));
  fireEvent.click(screen.getByRole('button', { name: 'OK' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('git.pull', {
      fingerprint: 'reviewed',
      strategy: 'rebase',
    }),
  );
  expect(api.setSetting).toHaveBeenCalledWith('git.updateProject', {
    strategy: 'rebase',
    skipDialog: true,
  });
  expect(screen.getByRole('status').textContent).toContain("Updating 'main'");
  await act(async () => finish(result));
  expect(screen.getByRole('status').textContent).toContain('2 files updated in 1 commit');
  fireEvent.click(screen.getByRole('button', { name: 'View Commits' }));
  expect(
    (await screen.findByRole('dialog', { name: 'Updated commits · main' })).textContent,
  ).toContain('Incoming fix');
});
it('cancel sends nothing and failed updates remain visible', async () => {
  const view = render(
    <GitActivityProvider>
      <Launcher />
    </GitActivityProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
  expect(request).not.toHaveBeenCalled();
  view.unmount();
  vi.mocked(request).mockRejectedValue(new Error('Resolve conflicts in the Git panel'));
  render(
    <GitActivityProvider>
      <Launcher />
    </GitActivityProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'OK' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Resolve conflicts');
  expect(screen.queryByText('2 files updated in 1 commit')).toBeNull();
});
it('honors the remembered strategy and allows reopening options', async () => {
  vi.mocked(api.getSetting).mockResolvedValue({ strategy: 'rebase', skipDialog: true });
  const view = render(
    <GitActivityProvider>
      <Launcher />
    </GitActivityProvider>,
  );
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('git.pull', {
      fingerprint: 'reviewed',
      strategy: 'rebase',
    }),
  );
  view.unmount();
  vi.mocked(request).mockClear();
  render(
    <GitActivityProvider>
      <Launcher showOptions />
    </GitActivityProvider>,
  );
  const radio = await screen.findByRole('radio', {
    name: 'Rebase the current branch on top of incoming changes',
  });
  expect((radio as HTMLInputElement).checked).toBe(true);
  expect(request).not.toHaveBeenCalled();
});
