// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { GitRemoteStatus } from '../contracts';
import { useGitRemote } from './git-remote';
const status = (root: string, current = 'main'): GitRemoteStatus => ({
  root,
  current,
  branches: [],
  fetch: { state: 'ready', version: 1, lastFetched: 1, error: null },
});
const { read, refresh } = vi.hoisted(() => ({ read: vi.fn(), refresh: vi.fn() }));
vi.mock('../api', () => ({ api: { gitRemoteStatus: read, refreshGitRemote: refresh } }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  read.mockReset();
  refresh.mockReset();
  vi.useRealTimers();
});
it('polls in the background with the Git panel closed and refreshes on focus', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  read.mockResolvedValue(status('/repo'));
  refresh.mockResolvedValue(status('/repo', 'topic'));
  const { result } = renderHook(() => useGitRemote('/repo', 1, 0));
  await act(async () => {});
  expect(result.current.remote?.current).toBe('main');
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => {
    vi.advanceTimersByTime(5000);
  });
  expect(read).toHaveBeenCalledTimes(3);
  await act(async () => {
    result.current.refresh();
  });
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(result.current.remote?.current).toBe('topic');
});
it('does not show a late response from the previous workspace', async () => {
  let finish: (value: GitRemoteStatus) => void = () => {};
  read
    .mockImplementationOnce(
      () =>
        new Promise<GitRemoteStatus>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(status('/new', 'new-main'));
  const { result, rerender } = renderHook(
    ({ root, generation }) => useGitRemote(root, generation, 0),
    { initialProps: { root: '/old', generation: 1 } },
  );
  rerender({ root: '/new', generation: 2 });
  await waitFor(() => expect(result.current.remote?.root).toBe('/new'));
  await act(async () => {
    finish(status('/old', 'old-main'));
  });
  expect(result.current.remote?.current).toBe('new-main');
});
it('surfaces a manual refresh failure while retaining cached branch counts', async () => {
  read.mockResolvedValue(status('/repo'));
  refresh.mockRejectedValue(new Error('Git transport unavailable'));
  const { result } = renderHook(() => useGitRemote('/repo', 1, 0));
  await waitFor(() => expect(result.current.remote?.current).toBe('main'));
  await act(async () => {
    await expect(result.current.refresh()).rejects.toThrow('Git transport unavailable');
  });
  expect(result.current.remote?.current).toBe('main');
  expect(result.current.remote?.fetch.state).toBe('failed');
  expect(result.current.remote?.fetch.error).toBe('Git transport unavailable');
});
it('keeps an older poll from overwriting the result of a manual refresh', async () => {
  let finish!: (value: GitRemoteStatus) => void;
  read.mockImplementationOnce(
    () =>
      new Promise<GitRemoteStatus>((resolve) => {
        finish = resolve;
      }),
  );
  refresh.mockResolvedValue(status('/repo', 'new-main'));
  const { result } = renderHook(() => useGitRemote('/repo', 1, 0));
  await act(async () => {
    await result.current.refresh();
  });
  await act(async () => {
    finish(status('/repo', 'old-main'));
  });
  expect(result.current.remote?.current).toBe('new-main');
});
it('checks an active fetch after one second without speeding up ordinary polling', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  read
    .mockResolvedValueOnce({
      ...status('/repo'),
      fetch: { ...status('/repo').fetch, state: 'fetching' },
    })
    .mockResolvedValue(status('/repo'));
  const { result } = renderHook(() => useGitRemote('/repo', 1, 0));
  await act(async () => {});
  expect(result.current.remote?.fetch.state).toBe('fetching');
  await act(async () => {
    vi.advanceTimersByTime(1000);
  });
  expect(result.current.remote?.fetch.state).toBe('ready');
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => {
    vi.advanceTimersByTime(4000);
  });
  expect(read).toHaveBeenCalledTimes(2);
});
it('observes an in-flight fetch completing even when the window becomes hidden', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  read
    .mockResolvedValueOnce({
      ...status('/repo'),
      fetch: { ...status('/repo').fetch, state: 'fetching' },
    })
    .mockResolvedValue(status('/repo'));
  const { result } = renderHook(() => useGitRemote('/repo', 1, 0));
  await act(async () => {});
  await act(async () => {
    vi.advanceTimersByTime(1000);
  });
  expect(result.current.remote?.fetch.state).toBe('ready');
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => {
    vi.advanceTimersByTime(5000);
  });
  expect(read).toHaveBeenCalledTimes(2);
});
