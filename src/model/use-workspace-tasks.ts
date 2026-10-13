import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { api } from '../api';
import { WorkspaceRunSession } from './run-configurations';

const sessions = new Map<string, WorkspaceRunSession>();
const empty = new WorkspaceRunSession('', api);
export function useWorkspaceTasks(root?: string) {
  const session = useMemo(() => {
    if (!root) return empty;
    if (!sessions.has(root)) sessions.set(root, new WorkspaceRunSession(root, api));
    return sessions.get(root)!;
  }, [root]);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useEffect(() => {
    if (root) void session.load();
  }, [root, session]);
  return { session, state };
}
