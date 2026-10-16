import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { GitRemoteStatus } from '../contracts';

/** One workspace poller keeps remote badges fresh even with the Git panel closed. */
export function useGitRemote(
  root: string | undefined,
  generation: number | undefined,
  revision: number,
) {
  const key = `${root ?? ''}:${generation ?? ''}`;
  const latestKey = useRef(key);
  latestKey.current = key;
  const [value, setValue] = useState<{ key: string; status: GitRemoteStatus }>();
  useEffect(() => {
    if (!root) return;
    let active = true,
      pending = false;
    const check = async () => {
      if (pending) return;
      pending = true;
      try {
        const status = await api.gitRemoteStatus();
        if (active) setValue({ key, status });
      } catch {
        /* A non-Git workspace or a workspace transition has no remote indicator. */
      } finally {
        pending = false;
      }
    };
    const visibleCheck = () => {
      if (!document.hidden) void check();
    };
    void check();
    const timer = setInterval(visibleCheck, 5000);
    window.addEventListener('focus', visibleCheck);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('focus', visibleCheck);
    };
  }, [root, key, revision]);
  const refresh = useCallback(() => {
    if (!root) return;
    void api
      .refreshGitRemote()
      .then((status) => {
        if (latestKey.current === key) setValue({ key, status });
      })
      .catch(() => {});
  }, [root, key]);
  return { remote: value?.key === key ? value.status : undefined, refresh };
}
