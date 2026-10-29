import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, request } from '../api';
import type { GitMutation, GitBranch as Branch, GitRemoteStatus, GitSnapshot } from '../contracts';
import { asError } from '../model/document-session';
import { BranchDiffWindow } from './BranchDiffWindow';
import { Modal } from './Modal';
import { branchUpdateNotice, useGitActivity } from './GitActivity';
import { Icon } from './Icon';
import { IncomingChanges, incomingBranches } from './IncomingChanges';

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
  disabled?: boolean;
  danger?: boolean;
}
type View =
  | { kind: 'list' }
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
  remoteStatus,
  onFetch,
  onOpenGit,
}: {
  onClose(): void;
  onChanged(change: BranchChange): void;
  remoteStatus?: GitRemoteStatus;
  onFetch?(snapshot: GitSnapshot): void | Promise<void>;
  onOpenGit?(): void;
}) {
  const gitActivity = useGitActivity();
  const latestRemote = useRef(remoteStatus);
  latestRemote.current = remoteStatus;
  const [snapshot, setSnapshot] = useState<GitSnapshot | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>({ kind: 'list' });
  const latestView = useRef(view);
  latestView.current = view;
  const fetchedVersion = useRef(remoteStatus?.fetch.version);
  const [index, setIndex] = useState(0);
  // The branch whose actions are open in the side menu, and the highlighted action.
  const [submenu, setSubmenu] = useState<Branch | null>(null);
  const [actionIndex, setActionIndex] = useState(0);
  const filter = useRef<HTMLInputElement>(null);
  const [showAllRemote, setShowAllRemote] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [operation, setOperation] = useState('none');
  const [pending, setPending] = useState('Loading branches…');
  const locked = useRef(false);
  const fetchLock = useRef(false);
  const menu = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState('');
  const body = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // The action menu flies out beside the dialog, level with its branch row, as in IntelliJ.
  const [flyout, setFlyout] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!submenu) return setFlyout(null);
    const place = () => {
      const dialog = body.current?.closest('dialog')?.getBoundingClientRect();
      const row = list.current?.querySelector('[data-expanded]')?.getBoundingClientRect();
      if (!dialog || !row) return;
      const width = menu.current?.getBoundingClientRect().width || 280;
      const height = menu.current?.getBoundingClientRect().height || 200;
      const right = dialog.right + 4;
      setFlyout({
        left: right + width <= innerWidth ? right : Math.max(4, dialog.left - width - 4),
        top: Math.max(8, Math.min(row.top - 30, innerHeight - height - 8)),
      });
    };
    place();
    const scroller = list.current;
    scroller?.addEventListener('scroll', place);
    window.addEventListener('resize', place);
    return () => {
      scroller?.removeEventListener('scroll', place);
      window.removeEventListener('resize', place);
    };
  }, [submenu]);

  async function readRepository() {
    const [status, result, state] = await Promise.all([
      api.gitStatus(),
      request<{ branches: Branch[] }>('git.branches'),
      request<{ operation: string }>('git.operationState'),
    ]);
    return { status, branches: result.branches, operation: state.operation };
  }
  function acceptRepository(result: Awaited<ReturnType<typeof readRepository>>, useRemote = true) {
    setSnapshot(result.status);
    setBranches(
      ((useRemote && latestRemote.current?.branches) || result.branches).filter(
        (branch) => !branch.name.endsWith('/HEAD'),
      ),
    );
    setOperation(result.operation);
  }
  useEffect(() => {
    let active = true;
    void readRepository()
      .then((result) => {
        if (active) acceptRepository(result);
      })
      .catch((e) => active && setError(asError(e).message))
      .finally(() => active && setBusy(false));
    return () => {
      active = false;
    };
  }, []);

  // Polls may update badges, but never silently approve a newer fingerprint
  // while an input or confirmation is being reviewed.
  useEffect(() => {
    if (!remoteStatus || latestView.current.kind !== 'list' || locked.current) return;
    setBranches(remoteStatus.branches.filter((branch) => !branch.name.endsWith('/HEAD')));
    if (
      fetchedVersion.current === remoteStatus.fetch.version ||
      remoteStatus.fetch.state === 'fetching'
    )
      return;
    fetchedVersion.current = remoteStatus.fetch.version;
    let active = true;
    void readRepository()
      .then((result) => {
        if (active && latestView.current.kind === 'list' && !locked.current)
          acceptRepository(result);
      })
      .catch((e) => active && setError(asError(e).message));
    return () => {
      active = false;
    };
  }, [remoteStatus]);
  useLayoutEffect(() => {
    if (view.kind === 'list') list.current?.focus();
  }, [view.kind]);
  const flyoutReady = flyout !== null;
  useLayoutEffect(() => {
    if (submenu && flyoutReady)
      menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [submenu?.name, flyoutReady]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [index]);
  async function reload() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setPending('Refreshing branches…');
    setError('');
    setSubmenu(null);
    try {
      acceptRepository(await readRepository(), false);
      setView({ kind: 'list' });
      setIndex(0);
      list.current?.focus();
    } catch (e) {
      setError(asError(e).message);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  function fetchOrigin() {
    if (
      !onFetch ||
      !snapshot ||
      locked.current ||
      fetchLock.current ||
      gitActivity.busy ||
      latestRemote.current?.fetch.state === 'fetching'
    )
      return;
    fetchLock.current = true;
    const started = gitActivity.run({
      pending: 'Fetching origin…',
      success: 'Fetch from origin completed.',
      failure: 'Fetch from origin failed.',
      task: () => Promise.resolve(onFetch(snapshot)),
    });
    if (started) onClose();
    else fetchLock.current = false;
  }
  const fetching = remoteStatus?.fetch.state === 'fetching';
  const blocked = busy || gitActivity.busy || fetching || operation !== 'none';
  const incoming = incomingBranches(branches);
  const current = snapshot?.branch ?? '';
  const currentBranch = branches.find((branch) => branch.current && !branch.remote);
  const detached = !!snapshot && snapshot.branch === 'Detached HEAD';
  const diverged = (currentBranch?.ahead ?? 0) > 0 && (currentBranch?.behind ?? 0) > 0;
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
    if (
      !snapshot ||
      locked.current ||
      gitActivity.busy ||
      fetchLock.current ||
      latestRemote.current?.fetch.state === 'fetching' ||
      operation !== 'none'
    )
      return;
    locked.current = true;
    if (method === 'git.updateBranch' || method === 'git.pushBranch') {
      const branch = String(params.branch ?? snapshot.branch);
      const updating = method === 'git.updateBranch';
      const started = gitActivity.run({
        pending: updating ? `Updating '${branch}'…` : `Pushing '${branch}'…`,
        success: updating
          ? (result: GitMutation) => branchUpdateNotice(result, branch)
          : `Branch '${branch}' pushed.`,
        failure: updating ? `Could not update '${branch}'.` : `Could not push '${branch}'.`,
        task: () => request<GitMutation>(method, { fingerprint: snapshot.fingerprint, ...params }),
        onSuccess: (result) =>
          onChanged({
            branch: result.snapshot.branch,
            message: result.output.trim() || 'Git operation completed.',
            conflicts: result.conflicts.length > 0,
          }),
      });
      if (started) onClose();
      else locked.current = false;
      return;
    }
    setBusy(true);
    setPending(operationLabel(method));
    setSubmenu(null);
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
      // Keep input and confirmation context so the user can correct or refresh it.
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function compare(branch: Branch, mode: Comparison['mode']) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setPending('Comparing branches…');
    setError('');
    try {
      const result = await request<Comparison>('git.compareBranch', {
        branch: branch.name,
        mode,
      });
      showView({ kind: 'compare', result });
    } catch (e) {
      setError(asError(e).message);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  function confirm(title: string, detail: string, label: string, submit: () => void) {
    setError('');
    showView({ kind: 'confirm', title, detail, confirm: label, submit });
  }
  function askName(title: string, label: string, initial: string, submit: (v: string) => void) {
    setError('');
    setValue(initial);
    showView({ kind: 'input', title, label, initial, submit });
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
    const add = (id: string, label: string, run: () => void) =>
      list.push({
        id,
        label,
        run,
        disabled: id === 'compare' || id === 'diff' ? busy : blocked,
        danger: id === 'delete',
      });
    const tracker = branch.remote
      ? branches.find((candidate) => !candidate.remote && candidate.upstream === name)
      : undefined;
    const checkoutName = tracker?.name ?? name;
    const checkoutParams = { branch: checkoutName, remote: branch.remote && !tracker };
    if (!isCurrent && !tracker?.current)
      add(
        'checkout',
        tracker ? `Checkout '${tracker.name}'` : 'Checkout',
        () => void mutate('git.switchBranch', checkoutParams),
      );
    add('new', `New Branch from '${name}'…`, () => newBranch(branch));
    if (!isCurrent && !tracker?.current)
      add('checkout-rebase', `Checkout and Rebase onto '${current}'`, () =>
        confirm(
          `Checkout '${checkoutName}' and rebase onto '${current}'?`,
          `'${checkoutName}' will be checked out, then its commits are replayed on top of '${current}'.`,
          'Checkout and rebase',
          () => void mutate('git.checkoutRebase', checkoutParams),
        ),
      );
    if (!isCurrent)
      add('compare', `Compare with '${current}'`, () => void compare(branch, 'branch'));
    add('diff', 'Show Diff with Working Tree', () => void compare(branch, 'workingTree'));
    const target = isCurrent ? branch.upstream : name;
    if (target && (!isCurrent || branches.some((candidate) => candidate.name === target))) {
      if (isCurrent)
        add(
          'compare',
          `Compare with '${target}'`,
          () =>
            void compare(
              branches.find((candidate) => candidate.name === target)!,
              'branch',
            ),
        );
      add('rebase', `Rebase '${current}' onto '${target}'`, () =>
        confirm(
          `Rebase '${current}' onto '${target}'?`,
          `The commits on '${current}' are replayed on top of '${target}'.`,
          'Rebase',
          () => void mutate('git.rebase', { ref: target }),
        ),
      );
      add('merge', `Merge '${target}' into '${current}'`, () =>
        confirm(
          `Merge '${target}' into '${current}'?`,
          `'${target}' is merged into the checked-out branch '${current}'.`,
          'Merge',
          () => void mutate('git.merge', { ref: target }),
        ),
      );
    }
    if (!branch.remote) {
      if (branch.upstream)
        add('update', isCurrent ? 'Pull (fast-forward)…' : 'Update (fast-forward)…', () =>
          confirm(
            `Pull updates into '${name}'?`,
            `Fast-forwards '${name}' from ${branch.upstream}. Diverged branches are not changed.`,
            isCurrent ? 'Pull (fast-forward)' : 'Update branch',
            () => void mutate('git.updateBranch', { branch: name }),
          ),
        );
      add('push', branch.upstream ? 'Push…' : 'Publish branch…', () =>
        confirm(
          `Push '${name}'?`,
          branch.upstream
            ? `Pushes '${name}' to ${branch.upstream}. Force push is never used.`
            : `'${name}' has no upstream. It is pushed to origin and set to track it.`,
          branch.upstream ? 'Push' : 'Publish branch',
          () => void mutate('git.pushBranch', { branch: name }),
        ),
      );
      const push = list.find((action) => action.id === 'push')!;
      push.disabled ||=
        (branch.behind ?? 0) > 0 ||
        (!branch.upstream && remoteStatus?.fetch.state === 'unavailable');
      const update = list.find((action) => action.id === 'update');
      if (update) update.disabled ||= (branch.ahead ?? 0) > 0 && (branch.behind ?? 0) > 0;
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
            'Deletes the local branch only. Git refuses if its commits are not fully merged.',
            'Delete',
            () => void mutate('git.deleteBranch', { branch: name }, () => forceDelete(branch)),
          ),
        );
    }
    return list;
  }
  function chooseRow(position: number) {
    if (busy || (position === 0 && blocked)) return;
    setIndex(position);
    if (position === 0) {
      setSubmenu(null);
      newBranch();
    } else if (rows[position - 1]) {
      setSubmenu(rows[position - 1]);
      setActionIndex(0);
    }
  }
  function closeSubmenu() {
    setSubmenu(null);
    list.current?.focus();
  }
  function showView(next: View) {
    setSubmenu(null);
    setView(next);
  }

  const actions = submenu
    ? actionsFor(
        branches.find(
          (branch) => branch.name === submenu.name && branch.remote === submenu.remote,
        ) ?? submenu,
      )
    : [];
  function back() {
    setView({ kind: 'list' });
    setSubmenu(null);
    setError('');
  }
  function pullCurrent() {
    if (currentBranch)
      actionsFor(currentBranch)
        .find((action) => action.id === 'update')
        ?.run();
  }
  function pushCurrent() {
    if (currentBranch)
      actionsFor(currentBranch)
        .find((action) => action.id === 'push')
        ?.run();
  }
  if (view.kind === 'compare' && view.result.mode === 'workingTree')
    return (
      <BranchDiffWindow branch={view.result.branch} files={view.result.files} onClose={onClose} />
    );
  const title = snapshot ? `Git Branches in ${snapshot.root.split('/').pop()}` : 'Git Branches';
  return (
    <Modal title={title} onClose={onClose} dismissible={!busy}>
      <div
        ref={body}
        className="modal-body branch-popup"
        aria-busy={busy}
        onKeyDown={(event) => {
          if (busy) return;
          const typing = event.target instanceof HTMLInputElement && view.kind === 'input';
          const step = (at: number, count: number) =>
            (at + (event.key === 'ArrowDown' ? 1 : count - 1)) % Math.max(1, count);
          if (event.key === 'Escape' && (submenu || view.kind !== 'list')) {
            event.preventDefault();
            event.stopPropagation();
            setError('');
            if (submenu) closeSubmenu();
            else back();
          } else if (typing || view.kind !== 'list') {
            return;
          } else if (
            !(event.target instanceof Element) ||
            (event.target !== list.current &&
              event.target !== filter.current &&
              !event.target.closest('[role="option"], [role="menuitem"]'))
          ) {
            return;
          } else if (submenu) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              let next = actionIndex;
              for (let count = 0; count < actions.length; count++) {
                next = step(next, actions.length);
                if (!actions[next].disabled) break;
              }
              setActionIndex(next);
              menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')[next]?.focus();
            } else if (event.key === 'Home' || event.key === 'End') {
              event.preventDefault();
              const enabled = actions
                .map((action, position) => (action.disabled ? -1 : position))
                .filter((position) => position >= 0);
              const next = event.key === 'Home' ? enabled[0] : enabled.at(-1);
              if (next !== undefined) {
                setActionIndex(next);
                menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')[next]?.focus();
              }
            } else if (event.key === 'Enter' || event.key === 'ArrowRight') {
              event.preventDefault();
              if (!actions[actionIndex]?.disabled) actions[actionIndex]?.run();
            } else if (event.key === 'ArrowLeft') {
              event.preventDefault();
              closeSubmenu();
            }
          } else if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            setIndex(event.key === 'Home' ? 0 : rows.length);
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setIndex(step(selectedIndex, rows.length + 1));
          } else if (event.key === 'Enter' || event.key === 'ArrowRight') {
            event.preventDefault();
            chooseRow(selectedIndex);
          } else if (
            event.target !== filter.current &&
            event.key.length === 1 &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey
          ) {
            event.preventDefault();
            setQuery((previous) => previous + event.key);
            setIndex(0);
            filter.current?.focus();
          }
        }}
      >
        {error && (
          <div className="branch-error">
            <p role="alert" className="error-message">
              {error}
            </p>
            <button disabled={busy} onClick={() => void reload()}>
              Refresh branches
            </button>
          </div>
        )}
        {busy && (
          <p role="status" className="branch-progress">
            {pending}
          </p>
        )}
        {operation !== 'none' && (
          <div className="branch-notice">
            <p>
              Finish the {operation === 'cherryPick' ? 'cherry-pick' : operation} before changing
              branches.
            </p>
            {onOpenGit && <button onClick={onOpenGit}>Resolve in Git panel</button>}
          </div>
        )}
        {view.kind === 'list' && (
          <>
            {snapshot && (
              <div className="branch-current">
                <div>
                  <Icon name="branch" />
                  <strong title={current}>
                    {detached ? `Detached HEAD · ${snapshot.head?.slice(0, 8)}` : current}
                  </strong>
                  <span className="muted">
                    {detached ? 'No branch checked out' : 'Current branch'}
                  </span>
                </div>
                <p className="muted">
                  {currentBranch?.upstream
                    ? `Tracking ${currentBranch.upstream}`
                    : !detached
                      ? 'No upstream configured. Publish this branch to start sharing it.'
                      : 'Create a branch to keep new commits.'}
                </p>
                {currentBranch?.upstream && (
                  <p className="branch-sync">
                    {currentBranch.ahead == null || currentBranch.behind == null
                      ? 'Upstream unavailable. Fetch to check its status.'
                      : diverged
                        ? 'Branches have diverged. Compare with the upstream, then merge or rebase before pulling or pushing.'
                        : currentBranch.behind
                          ? `${currentBranch.behind} incoming commit${currentBranch.behind === 1 ? '' : 's'} to pull`
                          : currentBranch.ahead
                            ? `${currentBranch.ahead} outgoing commit${currentBranch.ahead === 1 ? '' : 's'} to push`
                            : 'Up to date with the last fetched upstream.'}
                  </p>
                )}
                {snapshot.files.length > 0 && (
                  <p className="muted">
                    {snapshot.files.length} uncommitted file{snapshot.files.length === 1 ? '' : 's'}
                    . Commit or stash changes if Git cannot switch or integrate them safely.
                  </p>
                )}
                <div className="branch-quick-actions">
                  <button
                    disabled={blocked || !currentBranch?.upstream || diverged}
                    onClick={pullCurrent}
                  >
                    Pull (fast-forward)
                  </button>
                  <button
                    disabled={
                      blocked ||
                      !currentBranch ||
                      (currentBranch.behind ?? 0) > 0 ||
                      (!currentBranch.upstream && remoteStatus?.fetch.state === 'unavailable')
                    }
                    onClick={pushCurrent}
                  >
                    {currentBranch?.upstream ? 'Push…' : 'Publish branch…'}
                  </button>
                  {diverged &&
                    currentBranch?.upstream &&
                    branches.some((branch) => branch.name === currentBranch.upstream) && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void compare(
                            branches.find((branch) => branch.name === currentBranch.upstream)!,
                            'branch',
                          )
                        }
                      >
                        Compare with upstream
                      </button>
                    )}
                  {!error && (
                    <button
                      aria-label="Refresh branches"
                      title="Reload local branches and repository state"
                      disabled={busy || gitActivity.busy || fetching}
                      onClick={() => void reload()}
                    >
                      <Icon name="refresh" />
                    </button>
                  )}
                </div>
              </div>
            )}
            <div className="branch-remote-summary">
              {incoming > 0 && (
                <span>
                  <IncomingChanges
                    count={incoming}
                    label={`Updates to pull on ${incoming} ${incoming === 1 ? 'branch' : 'branches'}`}
                  />{' '}
                  {incoming} {incoming === 1 ? 'branch has' : 'branches have'} incoming changes
                </span>
              )}
              {fetching && (
                <span className="muted" role="status">
                  Fetching origin…
                </span>
              )}
              {remoteStatus?.fetch.state === 'failed' && (
                <span className="error-message" role="status">
                  {remoteStatus.fetch.error}
                </span>
              )}
              {remoteStatus?.fetch.lastFetched && (
                <span
                  className="muted"
                  title={new Date(remoteStatus.fetch.lastFetched * 1000).toLocaleString()}
                >
                  Last fetched{' '}
                  {new Date(remoteStatus.fetch.lastFetched * 1000).toLocaleString([], {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </span>
              )}
              {remoteStatus?.fetch.state === 'unavailable' && (
                <span className="muted">No origin remote configured.</span>
              )}
              {onFetch && remoteStatus?.fetch.state !== 'unavailable' && (
                <button
                  title="Check origin for new commits without changing local files"
                  onClick={() => void fetchOrigin()}
                  disabled={busy || gitActivity.busy || fetching}
                >
                  {fetching
                    ? 'Fetching…'
                    : remoteStatus?.fetch.state === 'failed'
                      ? 'Retry fetch'
                      : 'Fetch origin'}
                </button>
              )}
            </div>
          </>
        )}
        {view.kind === 'list' && (
          <div className="branch-panes">
            <div className="branch-main">
              <input
                ref={filter}
                aria-label="Filter branches"
                role="combobox"
                aria-expanded="true"
                aria-controls="branch-options"
                aria-activedescendant={`branch-option-${selectedIndex}`}
                aria-autocomplete="list"
                aria-describedby="branch-keyboard-help"
                placeholder="Search branches"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setIndex(0);
                  setSubmenu(null);
                }}
              />
              <div
                ref={list}
                id="branch-options"
                role="listbox"
                tabIndex={0}
                data-autofocus
                aria-activedescendant={`branch-option-${selectedIndex}`}
                aria-describedby="branch-keyboard-help"
                aria-label="Branches"
                className="branch-list"
              >
                <button
                  role="option"
                  id="branch-option-0"
                  tabIndex={-1}
                  aria-selected={selectedIndex === 0}
                  className={selectedIndex === 0 ? 'selected' : ''}
                  disabled={!snapshot || blocked}
                  onClick={() => chooseRow(0)}
                >
                  + New Branch
                </button>
                <h3>Local Branches</h3>
                {local.map((branch, position) => (
                  <BranchRow
                    key={branch.name}
                    id={`branch-option-${position + 1}`}
                    disabled={busy}
                    branch={branch}
                    expanded={submenu?.name === branch.name}
                    selected={selectedIndex === position + 1}
                    onChoose={() => chooseRow(position + 1)}
                  />
                ))}
                {!busy && !local.length && <p className="muted">No matching local branches.</p>}
                <h3>Remote Branches</h3>
                {remote.map((branch, position) => (
                  <BranchRow
                    key={branch.name}
                    id={`branch-option-${local.length + position + 1}`}
                    disabled={busy}
                    branch={branch}
                    expanded={submenu?.name === branch.name}
                    selected={selectedIndex === local.length + position + 1}
                    onChoose={() => chooseRow(local.length + position + 1)}
                  />
                ))}
                {!busy && !remoteAll.length && (
                  <p className="muted">
                    {needle
                      ? 'No matching remote branches.'
                      : 'No remote branches. Fetch origin to check for shared branches.'}
                  </p>
                )}
                {hiddenRemote > 0 && (
                  <button className="branch-more" onClick={() => setShowAllRemote(true)}>
                    Show {hiddenRemote.toLocaleString()} more…
                  </button>
                )}
              </div>
              <p id="branch-keyboard-help" className="branch-help muted">
                ↑ ↓ Navigate · Enter Actions · Type to search · Esc Back or close
              </p>
            </div>
            {submenu && (
              <div
                ref={menu}
                role="menu"
                aria-label={`Actions for ${submenu.name}`}
                className="branch-list branch-submenu"
                style={flyout ?? { visibility: 'hidden' }}
              >
                <h3 className="branch-heading">{submenu.name}</h3>
                {actions.map((action, position) => (
                  <button
                    key={action.id}
                    role="menuitem"
                    className={`${position === actionIndex ? 'selected' : ''}${action.danger ? ' danger' : ''}`}
                    tabIndex={position === actionIndex ? 0 : -1}
                    disabled={action.disabled}
                    onFocus={() => setActionIndex(position)}
                    onClick={action.run}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {view.kind === 'input' && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy && !blocked && value.trim() && value.trim() !== view.initial)
                view.submit(value.trim());
            }}
          >
            <h3 className="branch-heading">{view.title}</h3>
            <label className="field-label">
              {view.label}
              <input
                data-autofocus
                autoFocus
                value={value}
                disabled={busy}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setValue(e.target.value)}
              />
            </label>
            <div className="modal-actions">
              <button type="button" disabled={busy} onClick={back}>
                Back
              </button>
              <button
                className="primary"
                disabled={blocked || !value.trim() || value.trim() === view.initial}
              >
                {view.initial ? 'Rename branch' : 'Create and switch'}
              </button>
            </div>
          </form>
        )}
        {view.kind === 'confirm' && (
          <>
            <h3 className="branch-heading">{view.title}</h3>
            <p>{view.detail}</p>
            <div className="modal-actions">
              <button disabled={busy} onClick={back}>
                Back
              </button>
              <button
                className={view.confirm.toLowerCase().includes('delete') ? 'danger' : 'primary'}
                disabled={blocked}
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
            <button disabled={busy} onClick={back}>
              Back
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

function BranchRow({
  branch,
  id,
  disabled,
  selected,
  expanded,
  onChoose,
}: {
  branch: Branch;
  id: string;
  disabled: boolean;
  selected: boolean;
  expanded: boolean;
  onChoose(): void;
}) {
  return (
    <button
      role="option"
      id={id}
      tabIndex={-1}
      disabled={disabled}
      aria-haspopup="menu"
      aria-expanded={expanded}
      aria-selected={selected}
      data-expanded={expanded || undefined}
      aria-current={branch.current || undefined}
      className={selected ? 'selected' : ''}
      title={branch.subject}
      onClick={onChoose}
    >
      <span>
        {branch.current ? '★ ' : ''}
        {branch.name}
      </span>
      <IncomingChanges
        count={branch.behind ?? 0}
        label={`${branch.behind} incoming commit${branch.behind === 1 ? '' : 's'} ${branch.remote ? 'compared with local tracking branches' : `from ${branch.upstream}`}`}
      />
      {!branch.remote && (branch.ahead ?? 0) > 0 && (
        <span
          className="git-incoming git-outgoing"
          role="img"
          aria-label={`${branch.ahead} outgoing commit${branch.ahead === 1 ? '' : 's'} to ${branch.upstream}`}
          title={`${branch.ahead} outgoing to ${branch.upstream}`}
        >
          <Icon name="arrow" />
          <span aria-hidden="true">{branch.ahead}</span>
        </span>
      )}
      <span className="branch-upstream muted" title={branch.upstream}>
        {branch.upstream || (!branch.remote ? 'No upstream' : '')}
      </span>
      <span aria-hidden="true">›</span>
    </button>
  );
}

function operationLabel(method: string) {
  const labels: Record<string, string> = {
    'git.createBranch': 'Creating branch…',
    'git.switchBranch': 'Switching branch…',
    'git.checkoutRebase': 'Switching and rebasing…',
    'git.updateBranch': 'Pulling updates…',
    'git.pushBranch': 'Pushing branch…',
    'git.merge': 'Merging branches…',
    'git.rebase': 'Rebasing commits…',
    'git.renameBranch': 'Renaming branch…',
    'git.deleteBranch': 'Deleting branch…',
  };
  return labels[method] ?? 'Running Git operation…';
}
