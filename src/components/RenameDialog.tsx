import { useState } from 'react';
import { Modal } from './Modal';
export function RenameDialog({
  onRename,
  onClose,
  busy,
  error,
}: {
  onRename(name: string): void;
  onClose(): void;
  busy: boolean;
  error: string;
}) {
  const [name, setName] = useState('');
  return (
    <Modal title="Rename symbol" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onRename(name.trim());
        }}
      >
        <div className="modal-body">
          <label className="field-label">
            New name
            <input data-autofocus value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <p className="muted">
            The provider checks the affected scope before the edit preview opens.
          </p>
          {error && (
            <p role="alert" className="error-message">
              {error}
            </p>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !name.trim()}>
            {busy ? 'Finding affected usages…' : 'Preview rename'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
