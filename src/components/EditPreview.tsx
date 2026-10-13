import { useState } from 'react';
import type { WorkspaceEditPreview } from '../contracts';
import { Modal } from './Modal';
export function EditPreview({
  preview,
  title,
  busy,
  error,
  onApply,
  onClose,
}: {
  preview: WorkspaceEditPreview;
  title: string;
  busy: boolean;
  error: string;
  onApply(): void;
  onClose(): void;
}) {
  const [index, setIndex] = useState(0);
  const file = preview.files[index];
  return (
    <Modal
      title={title}
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      <div className="refactor-preview">
        <div className="refactor-files">
          <strong>{preview.files.length} affected files</strong>
          {preview.files.map((item, itemIndex) => (
            <button
              key={item.path}
              className={itemIndex === index ? 'selected' : ''}
              onClick={() => setIndex(itemIndex)}
              title={item.path}
            >
              {item.path.split('/').pop()}
              <span>{item.path}</span>
            </button>
          ))}
        </div>
        {file && (
          <div className="side-diff">
            <div>
              <div className="section-label">Before</div>
              <pre>{file.before}</pre>
            </div>
            <div>
              <div className="section-label">After</div>
              <pre>{file.after}</pre>
            </div>
          </div>
        )}
      </div>
      {error && (
        <p className="inline-notice error-message" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <span>Apply updates editor buffers. Save writes the changes to disk.</span>
        <button disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button className="primary" disabled={busy || !preview.files.length} onClick={onApply}>
          {busy ? 'Applying…' : 'Apply changes'}
        </button>
      </div>
    </Modal>
  );
}
