import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type {
  ChangelistSelection,
  Changelist,
  GitDiff,
  GitSnapshot,
  MergeSession,
  PushPlan,
} from '../contracts';
import { asError } from '../model/document-session';
import { assignmentsForMove } from '../model/changelists';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { PartialDiff } from './PartialDiff';
import { GitOperations } from './GitOperations';
import { PatchView } from './PatchView';
import type { MergeResolution } from './MergeEditor';
const MergeEditor = lazy(() =>
  import('./MergeEditor').then((module) => ({ default: module.MergeEditor })),
);
interface Selection {
  changes: Set<string> | null;
  fingerprint: string;
}
export function GitPanel({
  generation,
  onBranch,
}: {
  generation: number;
  onBranch(branch: string): void;
}) {
  const [snapshot, setSnapshot] = useState<GitSnapshot | null>(null);
  const [selected, setSelected] = useState<Map<string, Selection>>(new Map());
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [push, setPush] = useState<PushPlan | null>(null);
  const [merge, setMerge] = useState<MergeSession | null>(null);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [lists, setLists] = useState<Changelist[]>([]);
  const [list, setList] = useState('all');
  const [newList, setNewList] = useState(false);
  const [listName, setListName] = useState('');
  const [commit, setCommit] = useState<GitDiff[] | null>(null);
  const [preview, setPreview] = useState(0);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const diffRequest = useRef(0);
  const report = (e: unknown) => setError(asError(e).message);
  async function refresh() {
    setBusy(true);
    setError('');
    try {
      const [next, nextLists, nextConflicts] = await Promise.all([
        api.gitStatus(),
        api.changelists(),
        api.gitConflicts(),
      ]);
      setSnapshot(next);
      onBranch(next.branch);
      setLists(nextLists);
      setConflicts(nextConflicts);
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, [generation]);
  async function showDiff(path: string) {
    const id = ++diffRequest.current;
    try {
      const next = await api.gitDiff(path);
      if (id === diffRequest.current) setDiff(next);
    } catch (e) {
      report(e);
    }
  }
  async function overview() {
    setBusy(true);
    setError('');
    try {
      setPush(await api.pushPlan());
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  function chooseFile(path: string, checked: boolean) {
    if (!snapshot) return;
    setSelected((current) => {
      const next = new Map(current);
      if (checked) {
        const assignment = lists
          .find((item) => item.id === list)
          ?.selections?.find((item) => item.path === path);
        next.set(path, {
          changes: assignment ? new Set(assignment.changeIds) : null,
          fingerprint: assignment?.fingerprint ?? snapshot.fingerprint,
        });
      } else next.delete(path);
      return next;
    });
  }
  function chooseLines(ids: Set<string>) {
    if (!diff) return;
    setSelected((current) => {
      const next = new Map(current);
      if (ids.size) next.set(diff.path, { changes: ids, fingerprint: diff.fingerprint });
      else next.delete(diff.path);
      return next;
    });
  }
  const stale =
    snapshot && [...selected.values()].some((item) => item.fingerprint !== snapshot.fingerprint);
  async function reviewCommit() {
    setBusy(true);
    setError('');
    try {
      const previews = await Promise.all([...selected.keys()].map((path) => api.gitDiff(path)));
      if (previews.some((item) => item.fingerprint !== snapshot?.fingerprint))
        throw new Error('Changes have changed since selection. Refresh and select them again.');
      setPreview(0);
      setCommit(previews);
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  async function commitChanges() {
    if (!snapshot) return;
    setBusy(true);
    setError('');
    try {
      const selections = [...selected].map(([path, selection]) => ({
        path,
        ...(selection.changes === null ? {} : { changeIds: [...selection.changes] }),
      }));
      setSnapshot(await api.gitCommitSelection(selections, message, snapshot.fingerprint));
      setCommit(null);
      setMessage('');
      setSelected(new Map());
      setDiff(null);
      setNotice('Commit created.');
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  async function performPush() {
    if (!push) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.push(push.fingerprint);
      setNotice(result || 'Push completed.');
      setPush(null);
      await refresh();
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  async function resolve(path: string) {
    setBusy(true);
    setError('');
    try {
      setMerge(await api.mergeOpen(path));
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  async function applyResolution(choice: MergeResolution) {
    if (!merge) return;
    setBusy(true);
    setError('');
    try {
      setSnapshot(
        await api.mergeApply(merge.path, merge.fingerprint, choice.resolution, choice.result),
      );
      setMerge(null);
      await refresh();
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  function persistedSelections(): ChangelistSelection[] {
    return [...selected]
      .filter(([, value]) => value.changes !== null)
      .map(([path, value]) => ({
        path,
        changeIds: [...value.changes!],
        fingerprint: value.fingerprint,
      }));
  }
  function selectList(id: string) {
    setList(id);
    const saved = lists.find((item) => item.id === id);
    if (!saved || !snapshot) return;
    const next = new Map<string, Selection>();
    for (const path of saved.paths) {
      const partial = saved.selections?.find((item) => item.path === path);
      next.set(path, {
        changes: partial ? new Set(partial.changeIds) : null,
        fingerprint: partial?.fingerprint ?? snapshot.fingerprint,
      });
    }
    setSelected(next);
    if (saved.selections?.some((item) => item.stale))
      setNotice(
        'This changelist has outdated partial assignments. Review and select the intended changes again.',
      );
  }
  async function createList() {
    setBusy(true);
    setError('');
    try {
      const id = crypto.randomUUID();
      setLists(
        await api.saveChangelist(id, listName.trim(), [...selected.keys()], persistedSelections()),
      );
      setNewList(false);
      setListName('');
      setList(id);
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  async function assignToList(id: string) {
    const target = lists.find((item) => item.id === id);
    if (!target) return;
    try {
      setLists(
        await api.saveChangelist(
          id,
          target.name,
          [...new Set([...target.paths, ...selected.keys()])],
          assignmentsForMove(target, [...selected.keys()], persistedSelections()),
        ),
      );
      setNotice(`Selected changes assigned to ${target.name}.`);
    } catch (e) {
      report(e);
    }
  }
  async function deleteList() {
    if (list === 'all') return;
    try {
      setLists(await api.deleteChangelist(list));
      setList('all');
    } catch (e) {
      report(e);
    }
  }
  const files =
    snapshot?.files.filter(
      (file) => list === 'all' || lists.find((item) => item.id === list)?.paths.includes(file.path),
    ) ?? [];
  return (
    <section className="git-panel" aria-label="Git changes">
      <div className="results-summary">
        <Icon name="branch" />
        <strong>{snapshot?.branch || 'Git'}</strong>
        <span>{snapshot?.files.length ?? '—'} changed files</span>
        <div className="spacer" />
        <button disabled={busy} onClick={() => void refresh()}>
          <Icon name="refresh" />
          Refresh
        </button>
        <button disabled={busy || !selected.size || !!stale} onClick={() => void reviewCommit()}>
          Commit changes…
        </button>
        <button disabled={busy || !snapshot} onClick={() => void overview()}>
          <Icon name="arrow" />
          Push…
        </button>
      </div>
      {snapshot && (
        <GitOperations snapshot={snapshot} path={diff?.path} onUpdate={() => void refresh()} />
      )}
      <div className="changelist-bar">
        <label>
          Changelist{' '}
          <select aria-label="Changelist" value={list} onChange={(e) => selectList(e.target.value)}>
            <option value="all">All changes</option>
            {lists.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => setNewList(true)}>New…</button>
        {list !== 'all' && list !== 'default' && (
          <button onClick={() => void deleteList()}>Remove list</button>
        )}
        <div className="spacer" />
        {selected.size > 0 && (
          <>
            <span>{selected.size} files selected</span>
            <select
              aria-label="Assign selected files to changelist"
              value=""
              onChange={(e) => void assignToList(e.target.value)}
            >
              <option value="" disabled>
                Move to changelist…
              </option>
              {lists.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <button onClick={() => setSelected(new Map())}>Clear selection</button>
          </>
        )}
      </div>
      {error && (
        <p className="inline-notice error-message" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="inline-notice" role="status">
          {notice}
        </p>
      )}
      {stale && (
        <p className="inline-notice error-message">
          Changes have changed since selection. Select the intended changes again before committing.
        </p>
      )}
      <div className="git-content">
        <div className="git-files">
          {files.map((file) => (
            <div className="git-file" key={file.path}>
              <input
                type="checkbox"
                aria-label={`Include ${file.path} in commit`}
                checked={selected.has(file.path)}
                disabled={conflicts.includes(file.path)}
                onChange={(e) => chooseFile(file.path, e.target.checked)}
              />
              <button
                onClick={() =>
                  conflicts.includes(file.path) ? void resolve(file.path) : void showDiff(file.path)
                }
                title={file.path}
              >
                <span className="git-status">
                  {conflicts.includes(file.path)
                    ? '!'
                    : `${file.indexStatus}${file.worktreeStatus}`}
                </span>
                {file.path}
                {selected.get(file.path)?.changes && <span className="partial-label">partial</span>}
              </button>
              {conflicts.includes(file.path) && (
                <button className="resolve-button" onClick={() => void resolve(file.path)}>
                  Resolve
                </button>
              )}
            </div>
          ))}
          {snapshot && !files.length && (
            <p className="empty-note">
              {snapshot.files.length ? 'No changes in this changelist.' : 'Working tree is clean.'}
            </p>
          )}
        </div>
        <div className="diff-container">
          {diff ? (
            <PartialDiff
              diff={diff}
              selected={
                selected.get(diff.path)?.changes ?? (selected.has(diff.path) ? null : new Set())
              }
              onSelect={chooseLines}
            />
          ) : (
            <p className="empty-note">
              Select a changed file to inspect its diff. Select hunks or lines for a partial commit.
            </p>
          )}
        </div>
      </div>
      {newList && (
        <Modal title="New changelist" onClose={() => setNewList(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void createList();
            }}
          >
            <div className="modal-body">
              <label className="field-label">
                Name
                <input autoFocus value={listName} onChange={(e) => setListName(e.target.value)} />
              </label>
              <p className="muted">{selected.size} selected files will be included.</p>
              {error && (
                <p role="alert" className="error-message">
                  {error}
                </p>
              )}
            </div>
            <div className="modal-actions">
              <button type="button" onClick={() => setNewList(false)}>
                Cancel
              </button>
              <button className="primary" disabled={!listName.trim() || busy}>
                Create changelist
              </button>
            </div>
          </form>
        </Modal>
      )}
      {commit && snapshot && (
        <Modal
          title="Review commit"
          onClose={() => {
            if (!busy) setCommit(null);
          }}
          wide
        >
          <div className="commit-preview">
            <div className="commit-sidebar">
              <strong>{commit.length} selected files</strong>
              {commit.map((item, index) => (
                <button
                  key={item.path}
                  className={index === preview ? 'selected' : ''}
                  onClick={() => setPreview(index)}
                >
                  {item.path}
                  <span>{selected.get(item.path)?.changes ? 'Partial' : 'Whole file'}</span>
                </button>
              ))}
              <label className="field-label">
                Commit message
                <textarea
                  autoFocus
                  rows={5}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Describe the change"
                />
              </label>
            </div>
            <div className="diff-container">
              {commit[preview] && (
                <PartialDiff
                  diff={commit[preview]}
                  selected={selected.get(commit[preview].path)?.changes ?? null}
                  onSelect={() => {}}
                  readOnly
                />
              )}
            </div>
          </div>
          {error && (
            <p className="inline-notice error-message" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <span>
              Excluded lines are marked in the preview. Other staged and unstaged changes are
              preserved.
            </span>
            <button disabled={busy} onClick={() => setCommit(null)}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={busy || !message.trim()}
              onClick={() => void commitChanges()}
            >
              {busy ? 'Committing…' : 'Commit selected changes'}
            </button>
          </div>
        </Modal>
      )}
      {push && (
        <Modal
          title="Push overview"
          onClose={() => {
            if (!busy) setPush(null);
          }}
          wide
        >
          <div className="push-destination">
            <Icon name="arrow" />
            <strong>
              {push.remote} / {push.branch}
            </strong>
            <span>{push.upstream}</span>
          </div>
          <div className="push-content">
            <div className="push-commits">
              <h3>{push.commits.length} outgoing commits</h3>
              {push.commits.map((item) => (
                <div key={item.id} className="push-commit">
                  <strong>{item.subject}</strong>
                  <span>
                    <code>{item.id.slice(0, 8)}</code> · {item.author}
                  </span>
                </div>
              ))}
              <h3>{push.files.length} changed files</h3>
              {push.files.map((file) => (
                <div key={file} className="push-file">
                  {file}
                </div>
              ))}
            </div>
            <PatchView patch={push.diff} />
          </div>
          {error && (
            <p className="inline-notice error-message" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <span>Destination and outgoing changes are checked again before push.</span>
            <button disabled={busy} onClick={() => setPush(null)}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={busy || !push.commits.length}
              onClick={() => void performPush()}
            >
              {busy ? 'Pushing…' : `Push ${push.commits.length} commits`}
            </button>
          </div>
        </Modal>
      )}
      {merge && (
        <Suspense fallback={<div className="inline-notice">Opening merge editor…</div>}>
          <MergeEditor
            session={merge}
            busy={busy}
            error={error}
            onApply={(choice) => void applyResolution(choice)}
            onClose={() => setMerge(null)}
          />
        </Suspense>
      )}
    </section>
  );
}
