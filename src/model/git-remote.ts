import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { GitRemoteStatus } from '../contracts';
import { asError } from './document-session';

/** One workspace poller keeps remote badges fresh even with the Git panel closed. */
export function useGitRemote(
  root: string | undefined,
  generation: number | undefined,
  revision: number,
) {
  const key = `${root ?? ''}:${generation ?? ''}`;
  const latestKey = useRef(key);
  latestKey.current = key;
  const refreshVersion = useRef(0);
  const refreshing = useRef<{ key: string; promise: Promise<void> } | null>(null);
  const [value, setValue] = useState<{ key: string; status: GitRemoteStatus }>();
  const fetching = useRef(false);
  fetching.current = value?.key === key && value.status.fetch.state === 'fetching';
  useEffect(() => {
    if (!root) return;
    let active = true,
      pending = false;
    const check = async () => {
      if (pending) return;
      pending = true;
      const version = refreshVersion.current;
      try {
        const status = await api.gitRemoteStatus();
        if (active && version === refreshVersion.current) setValue({ key, status });
      } catch {
        /* A non-Git workspace or a workspace transition has no remote indicator. */
      } finally {
        pending = false;
      }
    };
    let ticks = 0;
    const visibleCheck = () => {
      ticks = 0;
      if (fetching.current || !document.hidden) void check();
    };
    void check();
    const timer = setInterval(() => {
      ticks += 1;
      if (fetching.current || ticks >= 5) {
        ticks = 0;
        visibleCheck();
      }
    }, 1000);
    window.addEventListener('focus', visibleCheck);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('focus', visibleCheck);
    };
  }, [root, key, revision]);
  const refresh = useCallback((): Promise<void> => {
    if (!root) return Promise.resolve();
    if (refreshing.current?.key === key) return refreshing.current.promise;
    refreshVersion.current += 1;
    setValue((previous) =>
      previous?.key === key
        ? {
            key,
            status: {
              ...previous.status,
              fetch: { ...previous.status.fetch, state: 'fetching', error: null },
            },
          }
        : previous,
    );
    const promise = api
      .refreshGitRemote()
      .then((status) => {
        if (latestKey.current === key) setValue({ key, status });
      })
      .catch((error: unknown) => {
        if (latestKey.current === key)
          setValue((previous) =>
            previous?.key === key
              ? {
                  key,
                  status: {
                    ...previous.status,
                    fetch: {
                      ...previous.status.fetch,
                      state: 'failed',
                      error: asError(error).message,
                    },
                  },
                }
              : previous,
          );
        throw error;
      })
      .finally(() => {
        if (refreshing.current?.promise === promise) refreshing.current = null;
      });
    refreshing.current = { key, promise };
    return promise;
  }, [root, key]);
  return { remote: value?.key === key ? value.status : undefined, refresh };
}
