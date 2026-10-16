import { useImperativeHandle, useState, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { request } from '../api';
import { Modal } from './Modal';
import './file-actions.css';

interface FileOperationPreview {
  id: string;
  path: string;
  destination?: string | null;
  bytes: number;
  operation: 'rename' | 'trash' | 'copy';
}
interface TrashEntry {
  id: string;
  path: string;
  bytes: number;
  createdAt: number;
  available: boolean;
}
export type FileActionMode = 'file' | 'directory' | 'rename' | 'trash' | 'restore' | 'copy';
type Mode = 'actions' | FileActionMode;
export interface FileActionsHandle {
  open(mode: FileActionMode, path: string, directory: boolean): void;
}
export type FileActionResult =
  | { operation: 'create' | 'restore' | 'copy'; path: string }
  | { operation: 'directory'; path?: string }
  | { operation: 'rename'; path: string; previousPath: string }
  | { operation: 'trash'; previousPath: string };

export function FileActions({
  ref,
  root,
  activePath,
  beforeMutation,
  onApplied,
}: {
  ref?: Ref<FileActionsHandle>;
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
  const [selectedPath, setSelectedPath] = useState<string>();
  const sourcePath = mode ? selectedPath : activePath;
  const included = sourcePath?.startsWith(`${root}/`) ? sourcePath : undefined;
  useImperativeHandle(ref, () => ({ open: choose }));
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
  function choose(next: Mode, path = included ?? activePath, directory = false) {
    setSelectedPath(path);
    const selectedRelative = path?.startsWith(`${root}/`) ? path.slice(root.length + 1) : '';
    setPreview(null);
    setError('');
    setMode(next);
    setRelativePath(
      next === 'rename'
        ? selectedRelative
        : next === 'copy'
          ? (() => {
              const dot = selectedRelative.lastIndexOf('.');
              return dot > selectedRelative.lastIndexOf('/') + 1
                ? `${selectedRelative.slice(0, dot)} copy${selectedRelative.slice(dot)}`
                : `${selectedRelative} copy`;
            })()
          : directory
            ? `${selectedRelative}/`
            : selectedRelative.slice(0, selectedRelative.lastIndexOf('/') + 1),
    );
    if (next === 'trash') void review('trash', path);
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
  async function review(operation: 'rename' | 'trash' | 'copy', path = included) {
    if (!path) return;
    await run(async () => {
      await beforeMutation();
      setPreview(
        await request<FileOperationPreview>('workspace.filePreview', {
          operation,
          path,
          ...(operation !== 'trash' ? { destination: relativePath } : {}),
        }),
      );
    });
  }
  async function apply() {
    if (!preview) return;
    await run(async () => {
      await beforeMutation();
      const result = await request<{ path?: string }>('workspace.fileApply', { id: preview.id });
      if (preview.operation === 'copy') {
        if (!result.path)
          throw new Error('Copied file path was not returned. Refresh the project.');
        await onApplied({ operation: 'copy', path: result.path });
      } else if (preview.operation === 'rename') {
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
        : mode === 'copy'
          ? 'Copy file'
          : mode === 'rename'
            ? 'Rename or move file'
            : mode === 'trash'
              ? 'Move file to IDE trash'
              : mode === 'restore'
                ? 'Recover files from IDE trash'
                : 'Project file actions';
  const form = mode === 'file' || mode === 'directory' || mode === 'rename' || mode === 'copy';
  return (
    <>
      <button
        className="file-actions-trigger"
        aria-label="Project file actions"
        title="Create, rename, or recover files"
        onClick={() => choose('actions', activePath)}
      >
        Files…
      </button>
      {mode &&
        createPortal(
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
                    if (mode === 'rename' || mode === 'copy') void review(mode);
                    else void create();
                  }}
                >
                  {(mode === 'rename' || mode === 'copy') && (
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
                      : preview.operation === 'copy'
                        ? 'Creates an independent copy. Existing files are never overwritten.'
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
                      <button
                        disabled={busy || !entry.available}
                        onClick={() => void restore(entry)}
                      >
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
                  {mode === 'rename' ? 'Review move' : mode === 'copy' ? 'Review copy' : 'Create'}
                </button>
              )}
              {preview && (
                <button
                  data-autofocus
                  className="primary"
                  disabled={busy}
                  onClick={() => void apply()}
                >
                  {preview.operation === 'trash'
                    ? 'Move to IDE trash'
                    : preview.operation === 'copy'
                      ? 'Copy file'
                      : 'Apply move'}
                </button>
              )}
            </div>
          </Modal>,
          document.body,
        )}
    </>
  );
}
