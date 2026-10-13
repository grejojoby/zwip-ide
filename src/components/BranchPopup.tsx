import { useEffect, useMemo, useRef, useState } from 'react';
import { api, request } from '../api';
import type { GitSnapshot } from '../contracts';
import { asError } from '../model/document-session';
import { Modal } from './Modal';

interface Branch {
  name: string;
  remote: boolean;
  current: boolean;
  upstream?: string;
  subject: string;
}
interface GitMutation {
  snapshot: GitSnapshot;
  output: string;
  conflicts: string[];
}
interface Comparison {
  current: string;
  branch: string;
  mode: 'branch' | 'workingTree';
  files: { status: string; path: string }[];
  incoming: { id: string; subject: string }[];
  outgoing: { id: string; subject: string }[];
}
interface Action {
  id: string;
  label: string;
  run(): void;
}
type View =
  | { kind: 'list' }
  | { kind: 'actions'; branch: Branch }
  | { kind: 'input'; title: string; label: string; initial: string; submit(value: string): void }
  | { kind: 'confirm'; title: string; detail: string; confirm: string; submit(): void }
  | { kind: 'compare'; result: Comparison };

const REMOTE_LIMIT = 50;

export interface BranchChange {
  branch: string;
  message: string;
  conflicts: boolean;
}

export function BranchPopup({
  onClose,
  onChanged,
}: {
  onClose(): void;
  onChanged(change: BranchChange): void;
}) {
  const [snapshot, setSnapshot] = useState<GitSnapshot | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>({ kind: 'list' });
  const [index, setIndex] = useState(0);
  const [showAllRemote, setShowAllRemote] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [value, setValue] = useState('');
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    Promise.all([api.gitStatus(), request<{ branches: Branch[] }>('git.branches')])
      .then(([status, result]) => {
        if (!active) return;
        setSnapshot(status);
        setBranches(result.branches.filter((branch) => !branch.name.endsWith('/HEAD')));
      })
      .catch((e) => active && setError(asError(e).message))
      .finally(() => active && setBusy(false));
    return () => {
      active = false;
    };
  }, []);

  const current = snapshot?.branch ?? '';
  const needle = query.trim().toLowerCase();
  const matching = (branch: Branch) => !needle || branch.name.toLowerCase().includes(needle);
  const local = useMemo(
    () =>
      branches
        .filter((branch) => !branch.remote && matching(branch))
        .sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name)),
    [branches, needle],
  );
  const remoteAll = useMemo(
    () =>
      branches
        .filter((branch) => branch.remote && matching(branch))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [branches, needle],
  );
  const remote = showAllRemote || needle ? remoteAll : remoteAll.slice(0, REMOTE_LIMIT);
  const hiddenRemote = remoteAll.length - remote.length;
  // Row 0 is "New Branch"; the rest are branches in display order.
  const rows = [...local, ...remote];
  const selectedIndex = Math.min(index, rows.length);

  async function mutate(method: string, params: Record<string, unknown>, retry?: () => View) {
    if (!snapshot) return;
    setBusy(true);
    setError('');
    try {
      const result = await request<GitMutation>(method, {
        fingerprint: snapshot.fingerprint,
        ...params,
      });
      onChanged({
        branch: result.snapshot.branch,
        message: result.output.trim() || 'Git operation completed.',
        conflicts: result.conflicts.length > 0,
      });
      onClose();
    } catch (e) {
      const message = asError(e).message;
      setError(message);
      if (retry && /not fully merged/.test(message)) setView(retry());
      else setView({ kind: 'list' });
    } finally {
      setBusy(false);
    }
  }
  async function compare(branch: Branch, mode: Comparison['mode']) {
    setBusy(true);
    setError('');
    try {
      const result = await request<Comparison>('git.compareBranch', {
        branch: branch.name,
        mode,
      });
      setView({ kind: 'compare', result });
    } catch (e) {
      setError(asError(e).message);
    } finally {
      setBusy(false);
    }
  }
  function confirm(title: string, detail: string, label: string, submit: () => void) {
    setError('');
    setView({ kind: 'confirm', title, detail, confirm: label, submit });
  }
  function askName(title: string, label: string, initial: string, submit: (v: string) => void) {
    setError('');
    setValue(initial);
    setView({ kind: 'input', title, label, initial, submit });
  }
  function newBranch(start?: Branch) {
    askName(
      start ? `New branch from '${start.name}'` : 'New branch',
      'Branch name',
      '',
      (name) =>
        void mutate('git.createBranch', {
          name,
          ...(start && { startPoint: start.name }),
        }),
    );
  }
  function forceDelete(branch: Branch): View {
    return {
      kind: 'confirm',
      title: `Force delete '${branch.name}'?`,
      detail: 'The branch has commits that are not merged. They may become unreachable.',
      confirm: 'Force delete',
      submit: () => void mutate('git.deleteBranch', { branch: branch.name, force: true }),
    };
  }
  function actionsFor(branch: Branch): Action[] {
    const name = branch.name;
    const isCurrent = branch.current;
    const list: Action[] = [];
    const add = (id: string, label: string, run: () => void) => list.push({ id, label, run });
    const checkoutParams = { branch: name, remote: branch.remote };
    if (!isCurrent)
      add('checkout', 'Checkout', () => void mutate('git.switchBranch', checkoutParams));
    add('new', `New Branch from '${name}'…`, () => newBranch(branch));
    if (!isCurrent)
      add('checkout-rebase', `Checkout and Rebase onto '${current}'`, () =>
        confirm(
          `Checkout '${name}' and rebase onto '${current}'?`,
          `'${name}' will be checked out, then its commits are replayed on top of '${current}'.`,
          'Checkout and rebase',
          () => void mutate('git.checkoutRebase', checkoutParams),
        ),
      );
    if (!isCurrent)
      add('compare', `Compare with '${current}'`, () => void compare(branch, 'branch'));
    add('diff', 'Show Diff with Working Tree', () => void compare(branch, 'workingTree'));
    if (!isCurrent) {
      add('rebase', `Rebase '${current}' onto '${name}'`, () =>
        confirm(
          `Rebase '${current}' onto '${name}'?`,
          `The commits on '${current}' are replayed on top of '${name}'.`,
          'Rebase',
          () => void mutate('git.rebase', { ref: name }),
        ),
      );
      add('merge', `Merge '${name}' into '${current}'`, () =>
        confirm(
          `Merge '${name}' into '${current}'?`,
          `'${name}' is merged into the checked-out branch '${current}'.`,
          'Merge',
          () => void mutate('git.merge', { ref: name }),
        ),
      );
    }
    if (!branch.remote) {
      if (branch.upstream)
        add('update', 'Update', () =>
          confirm(
            `Update '${name}'?`,
            `Fast-forwards '${name}' from ${branch.upstream}. Diverged branches are not changed.`,
            'Update',
            () => void mutate('git.updateBranch', { branch: name }),
          ),
        );
      add('push', 'Push…', () =>
        confirm(
          `Push '${name}'?`,
          branch.upstream
            ? `Pushes '${name}' to ${branch.upstream}. Force push is never used.`
            : `'${name}' has no upstream. It is pushed to origin and set to track it.`,
          'Push',
          () => void mutate('git.pushBranch', { branch: name }),
        ),
      );
      add('rename', 'Rename…', () =>
        askName(
          `Rename '${name}'`,
          'New name',
          name,
          (next) => void mutate('git.renameBranch', { branch: name, newName: next }),
        ),
      );
      if (!isCurrent)
        add('delete', 'Delete', () =>
          confirm(
            `Delete '${name}'?`,
            'Only branches fully merged into the current branch can be deleted this way.',
            'Delete',
            () => void mutate('git.deleteBranch', { branch: name }, () => forceDelete(branch)),
          ),
        );
    }
    return list;
  }
  function chooseRow(position: number) {
    if (position === 0) newBranch();
    else if (rows[position - 1]) {
      setError('');
      setView({ kind: 'actions', branch: rows[position - 1] });
      setIndex(0);
    }
  }

  const actions = view.kind === 'actions' ? actionsFor(view.branch) : [];
  const title = snapshot ? `Git Branches in ${snapshot.root.split('/').pop()}` : 'Git Branches';
  return (
    <Modal title={title} onClose={onClose} dismissible={!busy}>
      <div
        ref={body}
        className="modal-body branch-popup"
        onKeyDown={(event) => {
          if (busy) return;
          const typing = event.target instanceof HTMLInputElement && view.kind === 'input';
          if (event.key === 'Escape' && view.kind !== 'list') {
            event.preventDefault();
            event.stopPropagation();
            setError('');
            setView({ kind: 'list' });
            setIndex(0);
          } else if (typing) {
            return;
          } else if (view.kind === 'list' || view.kind === 'actions') {
            const count = view.kind === 'list' ? rows.length + 1 : actions.length;
            const at = view.kind === 'list' ? selectedIndex : index;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setIndex((at + (event.key === 'ArrowDown' ? 1 : count - 1)) % Math.max(1, count));
            } else if (
              event.key === 'Enter' ||
              (view.kind === 'list' && event.key === 'ArrowRight')
            ) {
              event.preventDefault();
              if (view.kind === 'list') chooseRow(selectedIndex);
              else actions[at]?.run();
            } else if (view.kind === 'actions' && event.key === 'ArrowLeft') {
              event.preventDefault();
              setView({ kind: 'list' });
            }
          }
        }}
      >
        {error && (
          <p role="alert" className="error-message">
            {error}
          </p>
        )}
        {view.kind === 'list' && (
          <>
            <input
              data-autofocus
              aria-label="Filter branches"
              placeholder="Search branches"
              value={query}
              disabled={busy && !snapshot}
              onChange={(event) => {
                setQuery(event.target.value);
                setIndex(0);
              }}
            />
            <div role="listbox" aria-label="Branches" className="branch-list">
              <button
                role="option"
                aria-selected={selectedIndex === 0}
                className={selectedIndex === 0 ? 'selected' : ''}
                disabled={!snapshot}
                onClick={() => chooseRow(0)}
              >
                + New Branch
              </button>
              <h3>Local Branches</h3>
              {local.map((branch, position) => (
                <BranchRow
                  key={branch.name}
                  branch={branch}
                  selected={selectedIndex === position + 1}
                  onChoose={() => chooseRow(position + 1)}
                />
              ))}
              {!local.length && <p className="muted">No matching local branches.</p>}
              <h3>Remote Branches</h3>
              {remote.map((branch, position) => (
                <BranchRow
                  key={branch.name}
                  branch={branch}
                  selected={selectedIndex === local.length + position + 1}
                  onChoose={() => chooseRow(local.length + position + 1)}
                />
              ))}
              {!remoteAll.length && <p className="muted">No matching remote branches.</p>}
              {hiddenRemote > 0 && (
                <button className="branch-more" onClick={() => setShowAllRemote(true)}>
                  Show {hiddenRemote.toLocaleString()} more…
                </button>
              )}
            </div>
          </>
        )}
        {view.kind === 'actions' && (
          <>
            <h3 className="branch-heading">{view.branch.name}</h3>
            <div role="menu" aria-label={`Actions for ${view.branch.name}`} className="branch-list">
              {actions.map((action, position) => (
                <button
                  key={action.id}
                  role="menuitem"
                  ref={(element) => {
                    if (position === index) element?.focus({ preventScroll: true });
                  }}
                  className={position === index ? 'selected' : ''}
                  disabled={busy}
                  onClick={action.run}
                >
                  {action.label}
                </button>
              ))}
            </div>
            <button onClick={() => setView({ kind: 'list' })}>Back</button>
          </>
        )}
        {view.kind === 'input' && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (value.trim()) view.submit(value.trim());
            }}
          >
            <h3 className="branch-heading">{view.title}</h3>
            <label className="field-label">
              {view.label}
              <input
                data-autofocus
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </label>
            <div className="modal-actions">
              <button type="button" onClick={() => setView({ kind: 'list' })}>
                Back
              </button>
              <button
                className="primary"
                disabled={busy || !value.trim() || value.trim() === view.initial}
              >
                OK
              </button>
            </div>
          </form>
        )}
        {view.kind === 'confirm' && (
          <>
            <h3 className="branch-heading">{view.title}</h3>
            <p>{view.detail}</p>
            <div className="modal-actions">
              <button onClick={() => setView({ kind: 'list' })}>Back</button>
              <button
                className="primary"
                disabled={busy}
                data-autofocus
                autoFocus
                onClick={view.submit}
              >
                {view.confirm}
              </button>
            </div>
          </>
        )}
        {view.kind === 'compare' && (
          <>
            <h3 className="branch-heading">
              {view.result.mode === 'workingTree'
                ? `'${view.result.branch}' vs working tree`
                : `'${view.result.current}' vs '${view.result.branch}'`}
            </h3>
            {view.result.mode === 'branch' && (
              <p className="muted">
                {view.result.incoming.length} commit{view.result.incoming.length === 1 ? '' : 's'}{' '}
                only in {view.result.branch}, {view.result.outgoing.length} only in{' '}
                {view.result.current}.
              </p>
            )}
            {view.result.mode === 'workingTree' && (
              <p className="muted">Tracked files only; untracked files are not compared.</p>
            )}
            {view.result.files.length ? (
              <ul className="branch-files" aria-label="Changed files">
                {view.result.files.map((file) => (
                  <li key={file.path}>
                    <code>{file.status}</code> {file.path}
                  </li>
                ))}
              </ul>
            ) : (
              <p>No file differences.</p>
            )}
            <button onClick={() => setView({ kind: 'list' })}>Back</button>
          </>
        )}
      </div>
    </Modal>
  );
}

function BranchRow({
  branch,
  selected,
  onChoose,
}: {
  branch: Branch;
  selected: boolean;
  onChoose(): void;
}) {
  return (
    <button
      role="option"
      aria-selected={selected}
      aria-current={branch.current || undefined}
      className={selected ? 'selected' : ''}
      title={branch.subject}
      onClick={onChoose}
    >
      <span>
        {branch.current ? '★ ' : ''}
        {branch.name}
      </span>
      <span className="muted">{branch.upstream}</span>
      <span aria-hidden="true">›</span>
    </button>
  );
}
