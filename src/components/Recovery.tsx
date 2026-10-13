import { useEffect, useState } from 'react';
import { api } from '../api';
import type { RecoveryEntry } from '../contracts';
import { asError } from '../model/document-session';
import { Modal } from './Modal';

export function Recovery({
  root,
  onClose,
  onOpen,
}: {
  root: string;
  onClose(): void;
  onOpen(path: string): void;
}) {
  const [entries, setEntries] = useState<RecoveryEntry[]>([]);
  const [selected, setSelected] = useState<RecoveryEntry | null>(null);
  const [destination, setDestination] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [discard, setDiscard] = useState(false);
  useEffect(() => {
    let active = true;
    api
      .recovery()
      .then((result) => {
        if (active) setEntries(result);
      })
      .catch((e) => {
        if (active) setError(asError(e).message);
      });
    return () => {
      active = false;
    };
  }, []);
  async function apply(remove: boolean) {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      if (remove) {
        await api.discardRecovery(selected.path, selected.revision);
        setEntries(await api.recovery());
        setSelected(null);
        setDiscard(false);
      } else {
        const result = await api.restoreRecoveryCopy(selected.path, selected.revision, destination);
        onOpen(result.path);
      }
    } catch (e) {
      setError(asError(e).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Unsaved buffer recovery" onClose={onClose}>
      <div className="modal-body">
        <p>
          Recovery is kept until you save or explicitly discard it. A restored copy never overwrites
          an existing file.
        </p>
        {error && (
          <p role="alert" className="error-message">
            {error}
          </p>
        )}
        <div className="history-entries" style={{ maxHeight: 240, overflow: 'auto' }}>
          {entries.map((entry) => (
            <button
              key={entry.path}
              className={selected?.path === entry.path ? 'selected' : ''}
              onClick={() => {
                setSelected(entry);
                setDestination(`${entry.path}.recovered`);
                setDiscard(false);
              }}
            >
              {entry.path.slice(root.length + 1)} · {entry.bytes.toLocaleString()} bytes
              {entry.missing ? ' · deleted on disk' : ''}
            </button>
          ))}
          {!entries.length && <p>No unsaved buffers in this workspace.</p>}
        </div>
        {selected && (
          <>
            <pre className="history-preview" style={{ maxHeight: 180, overflow: 'auto' }}>
              {selected.preview}
            </pre>
            <label>
              Restore copy to
              <input
                aria-label="Recovery destination"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
              />
            </label>
            {discard && (
              <p role="alert">
                Discard this recovery permanently? This removes the saved unsaved buffer.
              </p>
            )}
          </>
        )}
      </div>
      <div className="modal-actions">
        <button
          disabled={!selected || busy || selected.open}
          onClick={() => (discard ? void apply(true) : setDiscard(true))}
        >
          {discard ? 'Confirm discard' : 'Discard recovery'}
        </button>
        <button
          disabled={!selected || selected.missing || busy}
          onClick={() => selected && onOpen(selected.path)}
        >
          Open buffer
        </button>
        <button disabled={!selected || !destination || busy} onClick={() => void apply(false)}>
          Restore copy
        </button>
      </div>
    </Modal>
  );
}
