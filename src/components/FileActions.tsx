import { useState } from 'react';
import { request } from '../api';
import { Modal } from './Modal';
import './file-actions.css';

interface FileOperationPreview {
  id: string;
  path: string;
  destination?: string | null;
  bytes: number;
  operation: 'rename' | 'trash';
}
interface TrashEntry {
  id: string;
  path: string;
  bytes: number;
  createdAt: number;
  available: boolean;
}
type Mode = 'actions' | 'file' | 'directory' | 'rename' | 'trash' | 'restore';
export type FileActionResult =
  | { operation: 'create' | 'restore'; path: string }
  | { operation: 'directory'; path?: string }
  | { operation: 'rename'; path: string; previousPath: string }
  | { operation: 'trash'; previousPath: string };

export function FileActions({
  root,
  activePath,
  beforeMutation,
  onApplied,
}: {
  root: string;
  activePath?: string;
  beforeMutation(): Promise<void>;
  onApplied(result: FileActionResult): Promise<void>;
}) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [relativePath, setRelativePath] = useState('');
  const [preview, setPreview] = useState<FileOperationPreview | null>(null);
  const [trash, setTrash] = useState<TrashEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const included = activePath?.startsWith(`${root}/`) ? activePath : undefined;
  const activeRelative = included?.slice(root.length + 1);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  }
  function close() {
    if (!busy) setMode(null);
  }
  function choose(next: Mode) {
    setPreview(null);
    setError('');
    setMode(next);
    setRelativePath(
      next === 'rename'
        ? (activeRelative ?? '')
        : activeRelative?.includes('/')
          ? activeRelative.slice(0, activeRelative.lastIndexOf('/') + 1)
          : '',
    );
    if (next === 'trash') void review('trash');
    if (next === 'restore')
      void run(async () => setTrash(await request<TrashEntry[]>('workspace.trashList')));
  }
  async function create() {
    const operation = mode === 'directory' ? 'directory' : 'create';
    await run(async () => {
      await beforeMutation();
      const result = await request<{ path: string }>(
        mode === 'directory' ? 'workspace.createDirectory' : 'workspace.createFile',
        { relativePath },
      );
      await onApplied({ operation, path: result.path });
      setMode(null);
    });
  }
  async function review(operation: 'rename' | 'trash') {
    if (!included) return;
    await run(async () => {
      await beforeMutation();
      setPreview(
        await request<FileOperationPreview>('workspace.filePreview', {
          operation,
          path: included,
          ...(operation === 'rename' ? { destination: relativePath } : {}),
        }),
      );
    });
  }
  async function apply() {
    if (!preview) return;
    await run(async () => {
      await beforeMutation();
      const result = await request<{ path?: string }>('workspace.fileApply', { id: preview.id });
      if (preview.operation === 'rename') {
        if (!result.path)
          throw new Error(
            'The file was moved, but its new path was not returned. Refresh the project.',
          );
        await onApplied({ operation: 'rename', path: result.path, previousPath: preview.path });
      } else await onApplied({ operation: 'trash', previousPath: preview.path });
      setMode(null);
    });
  }
  async function restore(entry: TrashEntry) {
    await run(async () => {
      await beforeMutation();
      const result = await request<{ path: string }>('workspace.trashRestore', { id: entry.id });
      await onApplied({ operation: 'restore', path: result.path });
      setTrash(await request<TrashEntry[]>('workspace.trashList'));
    });
  }
  const title =
    mode === 'file'
      ? 'New file'
      : mode === 'directory'
        ? 'New folder'
        : mode === 'rename'
          ? 'Rename or move file'
          : mode === 'trash'
            ? 'Move file to IDE trash'
            : mode === 'restore'
              ? 'Recover files from IDE trash'
              : 'Project file actions';
  const form = mode === 'file' || mode === 'directory' || mode === 'rename';
  return (
    <>
      <button
        className="file-actions-trigger"
        aria-label="Project file actions"
        title="Create, rename, or recover files"
        onClick={() => choose('actions')}
      >
        Files…
      </button>
      {mode && (
        <Modal key={`${mode}:${preview ? 'preview' : 'form'}`} title={title} onClose={close}>
          <div className="modal-body file-actions-body" aria-busy={busy}>
            {mode === 'actions' && (
              <>
                <div className="file-actions-grid">
                  <button data-autofocus onClick={() => choose('file')}>
                    New file…
                  </button>
                  <button onClick={() => choose('directory')}>New folder…</button>
                  <button disabled={!included} onClick={() => choose('rename')}>
                    Rename or move file…
                  </button>
                  <button disabled={!included} onClick={() => choose('trash')}>
                    Move file to IDE trash…
                  </button>
                  <button onClick={() => choose('restore')}>Recover trashed files…</button>
                </div>
                <p className="muted">
                  {activeRelative
                    ? `Selected file: ${activeRelative}`
                    : 'Open a workspace file to rename or move it to trash.'}
                </p>
              </>
            )}
            {form && !preview && (
              <form
                id="file-action-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (mode === 'rename') void review('rename');
                  else void create();
                }}
              >
                {mode === 'rename' && (
                  <p>
                    Current file: <code>{activeRelative}</code>
                  </p>
                )}
                <label>
                  Path relative to project root
                  <input
                    data-autofocus
                    required
                    autoComplete="off"
                    spellCheck={false}
                    aria-label="Project relative path"
                    disabled={busy}
                    value={relativePath}
                    onChange={(event) => setRelativePath(event.target.value)}
                  />
                </label>
                <p className="muted file-action-path">{root}</p>
              </form>
            )}
            {preview && (
              <div className="file-action-preview">
                <dl>
                  <dt>Current path</dt>
                  <dd>{preview.path}</dd>
                  {preview.destination && (
                    <>
                      <dt>New path</dt>
                      <dd>{preview.destination}</dd>
                    </>
                  )}
                  <dt>Size</dt>
                  <dd>{preview.bytes.toLocaleString()} bytes</dd>
                </dl>
                <p>
                  {preview.operation === 'trash'
                    ? 'The file will move to recoverable IDE trash. Restore it from Project file actions.'
                    : 'This changes the file path. References and imports are not automatically rewritten.'}
                </p>
              </div>
            )}
            {mode === 'restore' && (
              <div className="file-trash-list">
                {trash.map((entry) => (
                  <div key={entry.id} className="file-trash-entry">
                    <div>
                      <strong>{entry.path}</strong>
                      <span>
                        {entry.bytes.toLocaleString()} bytes ·{' '}
                        {new Date(entry.createdAt * 1000).toLocaleString()}
                        {!entry.available && ' · Stored file unavailable'}
                      </span>
                    </div>
                    <button disabled={busy || !entry.available} onClick={() => void restore(entry)}>
                      Restore
                    </button>
                  </div>
                ))}
                {!busy && !trash.length && <p>No recoverable files in this project.</p>}
              </div>
            )}
            {busy && <p role="status">Working…</p>}
            {error && (
              <p className="error-message" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="modal-actions">
            <button disabled={busy} onClick={close}>
              {mode === 'actions' || mode === 'restore' ? 'Close' : 'Cancel'}
            </button>
            {preview && (
              <button
                disabled={busy}
                onClick={() => {
                  setPreview(null);
                  if (mode === 'trash') void review('trash');
                }}
              >
                {mode === 'trash' ? 'Refresh preview' : 'Edit destination'}
              </button>
            )}
            {form && !preview && (
              <button
                className="primary"
                type="submit"
                form="file-action-form"
                disabled={busy || !relativePath.trim()}
              >
                {mode === 'rename' ? 'Review move' : 'Create'}
              </button>
            )}
            {preview && (
              <button
                data-autofocus
                className="primary"
                disabled={busy}
                onClick={() => void apply()}
              >
                {preview.operation === 'trash' ? 'Move to IDE trash' : 'Apply move'}
              </button>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
