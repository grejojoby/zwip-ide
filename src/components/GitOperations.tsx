import { useEffect, useRef, useState } from 'react';
import { request } from '../api';
import type { GitMutation, GitRemoteStatus, GitSnapshot } from '../contracts';
import { asError } from '../model/document-session';
import { Modal } from './Modal';
import { branchUpdateNotice, useGitActivity } from './GitActivity';
import { IncomingChanges, incomingBranches } from './IncomingChanges';
interface Commit {
  id: string;
  parents: string[];
  subject: string;
  author: string;
  date: string;
}
interface Stash {
  ref: string;
  id: string;
  subject: string;
}
interface Annotation {
  line: number;
  commit: string;
  author: string;
  originalLine: number;
  text: string;
}
interface Operation {
  operation: 'merge' | 'rebase' | 'cherryPick' | 'revert' | 'none';
  fingerprint: string;
  conflicts: string[];
}
type Dialog = 'history' | 'stash' | 'blame' | null;
export function GitOperations({
  snapshot,
  path,
  onUpdate,
  remoteStatus,
  onOpenBranches,
}: {
  snapshot: GitSnapshot;
  remoteStatus?: GitRemoteStatus;
  onOpenBranches?(): void;
  path?: string;
  onUpdate(): void;
}) {
  const gitActivity = useGitActivity();
  const [operation, setOperation] = useState<Operation | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [stashes, setStashes] = useState<Stash[]>([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selected, setSelected] = useState('');
  const [message, setMessage] = useState('');
  const [untracked, setUntracked] = useState(false);
  const [confirm, setConfirm] = useState<'abort' | 'drop' | null>(null);
  const [working, setBusy] = useState(false);
  const busy = working || gitActivity.busy;
  const locked = useRef(false);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [output, setOutput] = useState('');
  useEffect(() => {
    let active = true;
    request<Operation>('git.operationState')
      .then((next) => {
        if (active) setOperation(next);
      })
      .catch((e) => {
        if (active) setError(asError(e).message);
      });
    return () => {
      active = false;
    };
  }, [snapshot.fingerprint]);
  const incoming = incomingBranches(remoteStatus?.branches);
  async function inspect(next: Dialog) {
    setBusy(true);
    setError('');
    setSelected('');
    try {
      if (next === 'history') setCommits(await request<Commit[]>('git.log', { limit: 100 }));
      if (next === 'stash') setStashes(await request<Stash[]>('git.stashes'));
      if (next === 'blame' && path)
        setAnnotations(await request<Annotation[]>('git.blame', { path }));
      setDialog(next);
    } catch (e) {
      setError(asError(e).message);
    } finally {
      setBusy(false);
    }
  }
  async function run(method: string, params: Record<string, unknown> = {}) {
    if (locked.current || gitActivity.busy) return;
    locked.current = true;
    if (method === 'git.fetch' || method === 'git.pull') {
      const fetching = method === 'git.fetch';
      const started = gitActivity.run({
        pending: fetching ? 'Fetching origin…' : `Updating '${snapshot.branch}'…`,
        success: fetching ? 'Fetch from origin completed.' : branchUpdateNotice,
        failure: fetching ? 'Fetch from origin failed.' : `Could not update '${snapshot.branch}'.`,
        task: () =>
          request<GitMutation>(method, { fingerprint: snapshot.fingerprint, ...params }).finally(
            () => {
              locked.current = false;
            },
          ),
        onSuccess: onUpdate,
      });
      if (started) {
        setDialog(null);
        setConfirm(null);
      } else locked.current = false;
      return;
    }
    setBusy(true);
    setPending('Running Git operation…');
    setError('');
    setOutput('');
    try {
      const result = await request<GitMutation>(method, {
        fingerprint: snapshot.fingerprint,
        ...params,
      });
      setOutput(result.output || 'Git operation completed.');
      setDialog(null);
      setConfirm(null);
      onUpdate();
    } catch (e) {
      setError(asError(e).message);
      onUpdate();
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  const activeOperation = operation && operation.operation !== 'none';
  const fetching = remoteStatus?.fetch.state === 'fetching';
  const current = remoteStatus?.branches.find((branch) => branch.current && !branch.remote);
  const diverged = (current?.ahead ?? 0) > 0 && (current?.behind ?? 0) > 0;
  return (
    <>
      <div className="git-operations">
        <button disabled={busy || !onOpenBranches} onClick={onOpenBranches}>
          Branches…{' '}
          <IncomingChanges
            count={incoming}
            label={`Updates to pull on ${incoming} ${incoming === 1 ? 'branch' : 'branches'}`}
          />
        </button>
        <button
          disabled={busy || fetching || remoteStatus?.fetch.state === 'unavailable'}
          title="Check origin for new commits without changing local files"
          onClick={() => void run('git.fetch')}
        >
          Fetch
        </button>
        <button
          disabled={
            busy ||
            fetching ||
            !!activeOperation ||
            diverged ||
            (remoteStatus !== undefined && !current?.upstream)
          }
          title={
            diverged
              ? 'Branches have diverged. Open Branches to compare, merge or rebase.'
              : 'Fast-forward the current branch from its upstream'
          }
          onClick={() => void run('git.pull')}
        >
          Pull (fast-forward)
        </button>
        <button disabled={busy} onClick={() => void inspect('history')}>
          History…
        </button>
        <button disabled={busy} onClick={() => void inspect('stash')}>
          Stash…
        </button>
        {path && (
          <button disabled={busy} onClick={() => void inspect('blame')}>
            Annotate file…
          </button>
        )}
        <div className="spacer" />
        {activeOperation && (
          <>
            <span>
              {operation.operation} · {operation.conflicts.length} conflicts
            </span>
            <button
              disabled={busy || operation.conflicts.length > 0}
              onClick={() => void run('git.continue', { fingerprint: operation.fingerprint })}
            >
              Continue
            </button>
            <button disabled={busy} onClick={() => setConfirm('abort')}>
              Abort…
            </button>
          </>
        )}
      </div>
      {working && pending && (
        <p role="status" className="inline-notice">
          {pending}
        </p>
      )}
      {error && !dialog && !confirm && (
        <p role="alert" className="inline-notice error-message">
          {error}
        </p>
      )}
      {output && (
        <pre className="git-operation-output" role="status">
          {output}
        </pre>
      )}
      {dialog && (
        <Modal
          title={
            dialog === 'history'
              ? 'Git history'
              : dialog === 'stash'
                ? 'Git stashes'
                : `Annotate · ${path}`
          }
          onClose={() => {
            if (!busy) setDialog(null);
          }}
          wide={dialog === 'history' || dialog === 'blame'}
        >
          <div className="modal-body">
            {dialog === 'history' && (
              <div className="commit-history-list">
                {commits.map((commit) => (
                  <button
                    key={commit.id}
                    className={selected === commit.id ? 'selected' : ''}
                    onClick={() => setSelected(commit.id)}
                  >
                    <code>{commit.id.slice(0, 8)}</code>
                    <strong>{commit.subject}</strong>
                    <span>{commit.author}</span>
                    <time>{new Date(commit.date).toLocaleDateString()}</time>
                  </button>
                ))}
                {!commits.length && <p className="empty-note">No commits yet.</p>}
              </div>
            )}
            {dialog === 'stash' && (
              <>
                <div className="git-selection-list">
                  {stashes.map((stash) => (
                    <button
                      key={stash.id}
                      className={selected === stash.ref ? 'selected' : ''}
                      onClick={() => setSelected(stash.ref)}
                    >
                      <strong>{stash.ref}</strong>
                      <span>{stash.subject}</span>
                    </button>
                  ))}
                  {!stashes.length && <p className="empty-note">No stashes.</p>}
                </div>
                <label className="field-label">
                  New stash message
                  <input
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="Work in progress"
                  />
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={untracked}
                    onChange={(e) => setUntracked(e.target.checked)}
                  />
                  Include untracked files
                </label>
                <button
                  disabled={busy || !snapshot.files.length}
                  onClick={() =>
                    void run('git.stashCreate', { message, includeUntracked: untracked })
                  }
                >
                  Stash working changes
                </button>
              </>
            )}
            {dialog === 'blame' && (
              <div className="blame-lines">
                {annotations.map((line, index) => (
                  <div key={index}>
                    <code>{line.commit.slice(0, 8)}</code>
                    <span>{line.author}</span>
                    <small>{line.line}</small>
                    <pre>{line.text}</pre>
                  </div>
                ))}
              </div>
            )}
            {error && (
              <p role="alert" className="error-message">
                {error}
              </p>
            )}
          </div>
          <div className="modal-actions">
            <button disabled={busy} onClick={() => setDialog(null)}>
              Close
            </button>
            {dialog === 'history' && (
              <button
                className="primary"
                disabled={busy || !selected}
                onClick={() => void run('git.cherryPick', { commit: selected })}
              >
                Cherry-pick selected commit
              </button>
            )}
            {dialog === 'stash' && (
              <>
                <button disabled={busy || !selected} onClick={() => setConfirm('drop')}>
                  Drop selected…
                </button>
                <button
                  disabled={busy || !selected}
                  onClick={() => void run('git.stashPop', { ref: selected })}
                >
                  Pop selected
                </button>
                <button
                  className="primary"
                  disabled={busy || !selected}
                  onClick={() => void run('git.stashApply', { ref: selected })}
                >
                  Apply selected
                </button>
              </>
            )}
          </div>
        </Modal>
      )}
      {confirm && (
        <Modal
          title={confirm === 'abort' ? `Abort ${operation?.operation}?` : `Drop ${selected}?`}
          onClose={() => {
            if (!busy) setConfirm(null);
          }}
        >
          <div className="modal-body">
            <p>
              {confirm === 'abort'
                ? 'This discards conflict resolutions made during the current Git operation and returns to its previous state.'
                : 'This removes the saved stash. Its changes may not be recoverable through the IDE.'}
            </p>
            {error && (
              <p role="alert" className="error-message">
                {error}
              </p>
            )}
          </div>
          <div className="modal-actions">
            <button disabled={busy} onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() =>
                void run(
                  confirm === 'abort' ? 'git.abort' : 'git.stashDrop',
                  confirm === 'abort' ? { fingerprint: operation?.fingerprint } : { ref: selected },
                )
              }
            >
              {confirm === 'abort' ? 'Discard resolutions and abort' : 'Drop stash'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
