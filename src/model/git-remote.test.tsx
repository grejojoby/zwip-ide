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
