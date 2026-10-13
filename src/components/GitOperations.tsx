import { useEffect, useState } from 'react';
import { request } from '../api';
import type { GitSnapshot } from '../contracts';
import { asError } from '../model/document-session';
import { Modal } from './Modal';
interface Branch {
  name: string;
  remote: boolean;
  current: boolean;
  upstream?: string;
  subject: string;
  oid: string;
}
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
interface GitMutation {
  snapshot: GitSnapshot;
  output: string;
  conflicts: string[];
}
type Dialog = 'branches' | 'history' | 'stash' | 'blame' | null;
export function GitOperations({
  snapshot,
  path,
  onUpdate,
}: {
  snapshot: GitSnapshot;
  path?: string;
  onUpdate(): void;
}) {
  const [operation, setOperation] = useState<Operation | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [stashes, setStashes] = useState<Stash[]>([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selected, setSelected] = useState('');
  const [branchName, setBranchName] = useState('');
  const [message, setMessage] = useState('');
  const [untracked, setUntracked] = useState(false);
  const [confirm, setConfirm] = useState<'abort' | 'drop' | null>(null);
  const [busy, setBusy] = useState(false);
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
  async function inspect(next: Dialog) {
    setBusy(true);
    setError('');
    setSelected('');
    try {
      if (next === 'branches')
        setBranches((await request<{ branches: Branch[] }>('git.branches')).branches);
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
    setBusy(true);
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
    } finally {
      setBusy(false);
    }
  }
  const activeOperation = operation && operation.operation !== 'none';
  return (
    <>
      <div className="git-operations">
        <button disabled={busy} onClick={() => void inspect('branches')}>
          Branches…
        </button>
        <button disabled={busy} onClick={() => void run('git.fetch')}>
          Fetch
        </button>
        <button disabled={busy} onClick={() => void run('git.pull')}>
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
            dialog === 'branches'
              ? 'Git branches'
              : dialog === 'history'
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
            {dialog === 'branches' && (
              <>
                <div className="git-selection-list">
                  {branches.map((branch) => (
                    <button
                      key={branch.name}
                      className={selected === branch.name ? 'selected' : ''}
                      onClick={() => setSelected(branch.name)}
                    >
                      <strong>
                        {branch.current ? '● ' : ''}
                        {branch.name}
                      </strong>
                      <span>
                        {branch.remote ? 'remote' : 'local'} · {branch.subject}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="branch-create">
                  <label className="field-label">
                    New branch name
                    <input
                      value={branchName}
                      onChange={(e) => setBranchName(e.target.value)}
                      placeholder="feature/name"
                    />
                  </label>
                  <button
                    disabled={busy || !branchName.trim()}
                    onClick={() =>
                      void run('git.createBranch', {
                        name: branchName.trim(),
                        ...(selected ? { startPoint: selected } : {}),
                      })
                    }
                  >
                    Create and switch
                  </button>
                </div>
                <p className="muted">
                  New branches start from {selected || snapshot.branch}. Existing branches are
                  changed only by an explicit action.
                </p>
              </>
            )}
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
            {dialog === 'branches' && (
              <>
                <button
                  disabled={busy || !selected}
                  onClick={() => void run('git.merge', { ref: selected })}
                >
                  Merge into {snapshot.branch}
                </button>
                <button
                  disabled={busy || !selected}
                  onClick={() => void run('git.rebase', { ref: selected })}
                >
                  Rebase onto selected
                </button>
                <button
                  className="primary"
                  disabled={
                    busy ||
                    !selected ||
                    selected === snapshot.branch ||
                    branches.some((branch) => branch.name === selected && branch.remote)
                  }
                  onClick={() => void run('git.switchBranch', { branch: selected })}
                >
                  Switch branch
                </button>
              </>
            )}
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
