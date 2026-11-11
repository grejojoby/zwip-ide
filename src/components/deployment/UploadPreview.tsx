import { useEffect, useRef, useState } from 'react';
import { MergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import type { DeploymentPlan } from '../../model/deployment-contracts';
import { Modal } from '../Modal';
function Comparison({
  local,
  remote,
  onClose,
}: {
  local: string;
  remote: string;
  onClose(): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const readOnly = [
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      lineNumbers(),
      EditorView.theme({
        '&': { background: 'var(--editor)', color: 'var(--text)' },
        '.cm-gutters': { background: 'var(--surface)', color: 'var(--muted)' },
      }),
    ];
    const view = new MergeView({
      parent: host.current!,
      a: {
        doc: remote,
        extensions: [...readOnly, EditorView.contentAttributes.of({ 'aria-label': 'Remote file' })],
      },
      b: {
        doc: local,
        extensions: [
          ...readOnly,
          EditorView.contentAttributes.of({ 'aria-label': 'Saved local file' }),
        ],
      },
      highlightChanges: true,
      gutter: true,
    });
    return () => view.destroy();
  }, [local, remote]);
  return (
    <Modal title="Compare remote and saved local file" wide onClose={onClose}>
      <div className="deployment-comparison-labels">
        <strong>Remote</strong>
        <strong>Saved local file</strong>
      </div>
      <div className="deployment-comparison" ref={host} />
      <div className="modal-actions">
        <button onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}
export function UploadPreview({
  plan,
  busy,
  onUpload,
  onCompare,
}: {
  plan: DeploymentPlan;
  busy: boolean;
  onUpload(keys: string[]): void;
  onCompare(key: string): Promise<{ local: string; remote: string; changed: boolean }>;
}) {
  const [selected, setSelected] = useState(
    () =>
      new Set(
        plan.files
          .filter((file) => file.action === 'create' || file.action === 'replace')
          .map((file) => file.key),
      ),
  );
  const [comparison, setComparison] = useState<{
    local: string;
    remote: string;
    changed: boolean;
  } | null>(null);
  const [error, setError] = useState('');
  const [comparing, setComparing] = useState(false);
  return (
    <section aria-label="Upload preview">
      <p>
        <strong>{plan.serverName}</strong> · Remote root: <code>{plan.root}</code>
      </p>
      <p className="muted">
        Only saved disk content is included. {plan.excluded} excluded entries. Select a conflict
        explicitly to replace its remote content.
      </p>
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      <div className="deployment-table-scroll">
        <table className="deployment-table">
          <thead>
            <tr>
              <th>Upload</th>
              <th>Saved local file → remote path</th>
              <th>Size</th>
              <th>Result</th>
              <th>Compare</th>
            </tr>
          </thead>
          <tbody>
            {plan.files.map((file) => (
              <tr key={file.key}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Upload ${file.local}`}
                    disabled={busy || file.action === 'blocked' || file.action === 'unchanged'}
                    checked={selected.has(file.key)}
                    onChange={(event) =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(file.key);
                        else next.delete(file.key);
                        return next;
                      })
                    }
                  />
                </td>
                <td>
                  <span>{file.local}</span>
                  <small>→ {file.remote}</small>
                  {file.reason && (
                    <small className={file.action === 'blocked' ? 'error-message' : 'muted'}>
                      {file.reason}
                    </small>
                  )}
                </td>
                <td>{file.bytes.toLocaleString()} B</td>
                <td>{file.action}</td>
                <td>
                  <button
                    disabled={
                      busy || comparing || file.action === 'blocked' || file.bytes > 1024 * 1024
                    }
                    onClick={() => {
                      setError('');
                      setComparing(true);
                      void onCompare(file.key)
                        .then((result) => {
                          if (result.changed)
                            setError(
                              'Remote content changed after preview. Generate a new preview before uploading.',
                            );
                          setComparison(result);
                        })
                        .catch((cause: unknown) =>
                          setError(cause instanceof Error ? cause.message : String(cause)),
                        )
                        .finally(() => setComparing(false));
                    }}
                  >
                    Compare
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!plan.files.length && <p>No mapped files are available in this selection.</p>}
      <div className="deployment-toolbar">
        <span className="muted">{selected.size} selected</span>
        <button
          className="primary"
          disabled={busy || !selected.size}
          onClick={() => onUpload([...selected])}
        >
          Upload {selected.size} {selected.size === 1 ? 'file' : 'files'}
        </button>
      </div>
      {comparison && <Comparison {...comparison} onClose={() => setComparison(null)} />}
    </section>
  );
}
