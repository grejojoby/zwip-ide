// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { branchUpdateNotice, GitActivityProvider, useGitActivity } from './GitActivity';
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it('keeps work and its notification alive after the initiating dialog closes', async () => {
  let finish!: () => void;
  const work = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const complete = vi.fn();
  function Launcher() {
    const [open, setOpen] = useState(true);
    const activity = useGitActivity();
    return (
      open && (
        <button
          onClick={() => {
            if (
              activity.run({
                pending: "Updating 'topic'…",
                success: "Branch 'topic' updated.",
                failure: "Could not update 'topic'.",
                task: work,
                onSuccess: complete,
              })
            )
              setOpen(false);
          }}
        >
          Update
        </button>
      )
    );
  }
  render(
    <GitActivityProvider>
      <Launcher />
    </GitActivityProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Update' }));
  expect(screen.queryByRole('button', { name: 'Update' })).toBeNull();
  expect(screen.getByRole('status').textContent).toContain("Updating 'topic'");
  await waitFor(() => expect(work).toHaveBeenCalledOnce());
  await act(async () => finish());
  expect(screen.getByRole('status').textContent).toContain("Branch 'topic' updated.");
  expect(complete).toHaveBeenCalledOnce();
});
it('blocks repeated starts and keeps failures visible until dismissed', async () => {
  let reject!: (reason: Error) => void;
  const work = vi.fn(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  );
  function Launcher() {
    const activity = useGitActivity();
    return (
      <button
        onClick={() =>
          activity.run({
            pending: 'Fetching origin…',
            success: 'Fetch completed.',
            failure: 'Fetch failed.',
            task: work,
          })
        }
      >
        Fetch
      </button>
    );
  }
  render(
    <GitActivityProvider>
      <Launcher />
    </GitActivityProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Fetch' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fetch' }));
  await waitFor(() => expect(work).toHaveBeenCalledOnce());
  await act(async () => reject(new Error('Network unavailable')));
  expect(screen.getByRole('alert').textContent).toContain('Fetch failed.');
  expect(screen.getByRole('alert').textContent).toContain('Network unavailable');
  expect(screen.queryByText('Fetch completed.')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss Git notification' }));
  expect(screen.queryByRole('alert')).toBeNull();
});

it('keeps progress visible and automatically dismisses a completed notification', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  function Launcher() {
    const activity = useGitActivity();
    return (
      <button
        onClick={() =>
          activity.run({
            pending: 'Updating branch…',
            success: 'Branch updated.',
            failure: 'Update failed.',
            task: () =>
              new Promise<void>((resolve) => {
                finish = resolve;
              }),
          })
        }
      >
        Update
      </button>
    );
  }
  render(
    <GitActivityProvider>
      <Launcher />
    </GitActivityProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Update' }));
  await act(async () => {});
  act(() => vi.advanceTimersByTime(16000));
  expect(screen.getByRole('status').textContent).toContain('Updating branch…');
  await act(async () => finish());
  expect(screen.getByRole('status').textContent).toContain('Branch updated.');
  act(() => vi.advanceTimersByTime(8000));
  expect(screen.queryByRole('status')).toBeNull();
});

it('reports an unchanged branch without inventing update counts', () => {
  expect(
    branchUpdateNotice({
      snapshot: { root: '/', branch: 'main', head: 'a', fingerprint: 'f', files: [] },
      output: '',
      conflicts: [],
      update: {
        branch: 'main',
        before: 'a',
        after: 'a',
        fileCount: 0,
        commitCount: 0,
        commits: [],
      },
    }).message,
  ).toBe("Branch 'main' is already up to date.");
});

it('keeps a focused notice visible after the pointer leaves it', async () => {
  vi.useFakeTimers();
  function Launcher() {
    const activity = useGitActivity();
    return (
      <button
        onClick={() =>
          activity.run({
            pending: 'Updating…',
            success: 'Updated.',
            failure: 'Failed.',
            task: async () => {},
          })
        }
      >
        Update
      </button>
    );
  }
  render(
    <GitActivityProvider>
      <Launcher />
    </GitActivityProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Update' }));
  await act(async () => {});
  const notice = screen.getByRole('status');
  fireEvent.mouseEnter(notice);
  fireEvent.focus(screen.getByRole('button', { name: 'Dismiss Git notification' }));
  fireEvent.mouseLeave(notice);
  act(() => vi.advanceTimersByTime(16000));
  expect(screen.getByText('Updated.')).toBeTruthy();
  fireEvent.blur(screen.getByRole('button', { name: 'Dismiss Git notification' }));
  act(() => vi.advanceTimersByTime(8000));
  expect(screen.queryByText('Updated.')).toBeNull();
});
