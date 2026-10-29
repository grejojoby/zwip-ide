import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { GitMutation, GitUpdateSummary } from '../contracts';
import { Modal } from './Modal';
import { asError } from '../model/document-session';
import './git-activity.css';

interface Operation<T> {
  pending: string;
  success: string | ((result: T) => { message: string; update?: GitUpdateSummary });
  failure: string;
  task(): Promise<T>;
  onSuccess?(result: T): void;
}
interface Notice {
  id: number;
  state: 'running' | 'success' | 'failed';
  message: string;
  detail?: string;
  update?: GitUpdateSummary;
}
const Context = createContext<{ busy: boolean; run<T>(operation: Operation<T>): boolean } | null>(
  null,
);
export function useGitActivity() {
  const activity = useContext(Context);
  if (!activity) throw new Error('Git operations require GitActivityProvider');
  return activity;
}

/** Own remote work outside its initiating dialog, and serialize reviewed Git mutations. */
export function GitActivityProvider({ children }: { children: ReactNode }) {
  const [viewing, setViewing] = useState<GitUpdateSummary | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const locked = useRef(false);
  const nextId = useRef(0);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const dismiss = useCallback(
    (id: number) => setNotices((items) => items.filter((item) => item.id !== id)),
    [],
  );
  const run = useCallback(<T,>(operation: Operation<T>) => {
    if (locked.current) return false;
    locked.current = true;
    const id = ++nextId.current;
    setNotices((items) => [...items, { id, state: 'running', message: operation.pending }]);
    // Start after the event handler has closed its modal. The provider remains mounted.
    void Promise.resolve()
      .then(operation.task)
      .then((result) => {
        if (!active.current) return;
        const success =
          typeof operation.success === 'string'
            ? { message: operation.success }
            : operation.success(result);
        setNotices((items) =>
          items.map((item) => (item.id === id ? { id, state: 'success', ...success } : item)),
        );
        operation.onSuccess?.(result);
      })
      .catch((error: unknown) => {
        if (active.current)
          setNotices((items) =>
            items.map((item) =>
              item.id === id
                ? {
                    id,
                    state: 'failed',
                    message: operation.failure,
                    detail: asError(error).message,
                  }
                : item,
            ),
          );
      })
      .finally(() => {
        locked.current = false;
      });
    return true;
  }, []);
  return (
    <Context.Provider value={{ busy: notices.some((notice) => notice.state === 'running'), run }}>
      {children}
      <div className="git-notifications" aria-label="Git notifications">
        {notices.map((notice) => (
          <GitNotice key={notice.id} notice={notice} dismiss={dismiss} onView={setViewing} />
        ))}
      </div>
      {viewing && (
        <Modal title={`Updated commits · ${viewing.branch}`} onClose={() => setViewing(null)}>
          <div className="updated-commits">
            <p>
              {viewing.commitCount} incoming {viewing.commitCount === 1 ? 'commit' : 'commits'} ·{' '}
              {viewing.fileCount} {viewing.fileCount === 1 ? 'file' : 'files'} updated
            </p>
            <ol>
              {viewing.commits.map((commit) => (
                <li key={commit.id}>
                  <strong>{commit.subject}</strong>
                  <span>
                    <code>{commit.id.slice(0, 8)}</code> · {commit.author}
                  </span>
                </li>
              ))}
            </ol>
            {viewing.commits.length < viewing.commitCount && (
              <p>Showing the latest {viewing.commits.length} commits.</p>
            )}
          </div>
          <div className="modal-actions">
            <button onClick={() => setViewing(null)}>Close</button>
          </div>
        </Modal>
      )}
    </Context.Provider>
  );
}
export function branchUpdateNotice(result: GitMutation, fallbackBranch = result.snapshot.branch) {
  const update = result.update;
  return {
    message: !update
      ? `Branch '${fallbackBranch}' updated.`
      : update.commitCount === 0
        ? `Branch '${update.branch}' is already up to date.`
        : `${update.fileCount} ${update.fileCount === 1 ? 'file' : 'files'} updated in ${update.commitCount} ${update.commitCount === 1 ? 'commit' : 'commits'}`,
    update,
  };
}
function GitNotice({
  notice,
  dismiss,
  onView,
}: {
  notice: Notice;
  dismiss(id: number): void;
  onView(update: GitUpdateSummary): void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  useEffect(() => {
    if (notice.state !== 'success' || paused) return;
    const timer = setTimeout(() => dismiss(notice.id), 8000);
    return () => clearTimeout(timer);
  }, [notice.id, notice.state, dismiss, paused]);
  return (
    <div
      className={`git-notification git-notification-${notice.state}`}
      role={notice.state === 'failed' ? 'alert' : 'status'}
      aria-atomic="true"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <span className="git-notification-icon" aria-hidden="true">
        {notice.state === 'running' ? '…' : notice.state === 'success' ? 'i' : '!'}
      </span>
      <div className="git-notification-content">
        <strong>{notice.message}</strong>
        {!!notice.update?.commitCount && (
          <button className="git-notification-action" onClick={() => onView(notice.update!)}>
            View Commits
          </button>
        )}
        {notice.detail && <p>{notice.detail}</p>}
      </div>
      {notice.state !== 'running' && (
        <button aria-label="Dismiss Git notification" onClick={() => dismiss(notice.id)}>
          ×
        </button>
      )}
    </div>
  );
}
