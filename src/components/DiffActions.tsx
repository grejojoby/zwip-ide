import { createContext, useContext, useState } from 'react';
import { request } from '../api';
import type { GitDiff } from '../contracts';
import { asError } from '../model/document-session';

export const DiffActionsContext = createContext<{
  edit?(diff: GitDiff): Promise<void>;
  revert?(diff: GitDiff, changeIds?: string[]): Promise<void>;
}>({});

export async function revertDiff(diff: GitDiff, changeIds?: string[]) {
  await request('git.revertDiff', {
    path: diff.path,
    fingerprint: diff.fingerprint,
    base: diff.base,
    revision: diff.revision,
    changeIds,
  });
}

export function DiffActions({
  diff,
  changeIds,
  label,
  onReverted,
  onEdit,
}: {
  diff: GitDiff;
  changeIds?: string[];
  label?: string;
  onReverted?(): void | Promise<void>;
  onEdit?(): void;
}) {
  const actions = useContext(DiffActionsContext);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const supported = !diff.binary && diff.kind === 'text' && diff.partialAllowed;
  const editable = !diff.binary && (diff.kind === 'text' || diff.kind === 'rename');
  const changed = diff.before !== diff.after;
  async function apply() {
    setBusy(true);
    setError('');
    try {
      await (actions.revert ?? revertDiff)(diff, changeIds);
      setConfirm(false);
      await onReverted?.();
    } catch (e) {
      setError(asError(e).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="diff-actions">
      {!changeIds && (
        <button
          disabled={!editable || !actions.edit || busy}
          title="Edit the working file with live change highlighting"
          onClick={() => {
            setError('');
            void actions
              .edit?.(diff)
              .then(() => onEdit?.())
              .catch((e) => setError(asError(e).message));
          }}
        >
          Edit file
        </button>
      )}
      <button
        disabled={!supported || !changed || busy}
        title={
          supported
            ? `Restore ${changeIds ? 'these lines' : 'this file'} to ${diff.base ? 'the comparison version' : 'HEAD'}`
            : 'Revert supports ordinary text files without conflicts or renames'
        }
        aria-label={label}
        onClick={() => {
          setError('');
          setConfirm(true);
        }}
      >
        {changeIds ? 'Revert hunk…' : 'Revert file…'}
      </button>
      {confirm && (
        <span
          className="diff-revert-confirm"
          role="alertdialog"
          aria-label={`Revert changes in ${diff.path}`}
        >
          <span>
            Revert {changeIds ? 'this hunk' : 'all displayed changes'} in {diff.path}?{' '}
            {diff.revision
              ? 'This creates a local reverse change; commits stay intact.'
              : diff.base
                ? 'The working file will be restored to the comparison version.'
                : 'The corresponding staged changes will also be reverted.'}
          </span>
          <button disabled={busy} onClick={() => setConfirm(false)}>
            Cancel
          </button>
          <button disabled={busy} onClick={() => void apply()}>
            {busy ? 'Reverting…' : 'Revert changes'}
          </button>
        </span>
      )}
      {error && (
        <span role="alert" className="error-message">
          {error}
        </span>
      )}
    </span>
  );
}
