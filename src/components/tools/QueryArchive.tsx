import { useEffect, useState } from 'react';
import { request } from '../../api';
import { asError } from '../../model/document-session';
import { Modal } from '../Modal';

type Entry = { id: string; title: string; category: string };
export function QueryArchive({ onClose }: { onClose(): void }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [selected, setSelected] = useState('');
  const [filter, setFilter] = useState('');
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    request<Entry[]>('queryArchive.list')
      .then((value) => {
        if (current) setEntries(value);
      })
      .catch((e) => {
        if (current) setError(asError(e).message);
      });
    return () => {
      current = false;
    };
  }, []);
  useEffect(() => {
    let current = true;
    setContent(null);
    if (!selected) return;
    setError('');
    request<{ content: string }>('queryArchive.get', { id: selected })
      .then((value) => {
        if (current) setContent(value.content);
      })
      .catch((e) => {
        if (current) setError(asError(e).message);
      });
    return () => {
      current = false;
    };
  }, [selected]);
  return (
    <Modal title="Imported queries and history" onClose={onClose} wide>
      <div className="modal-body procedure-viewer">
        <p className="panel-footnote">
          Original SQL files, including unmapped connections. Select and copy SQL into a
          connection’s console to run it. History metadata is preserved as imported.
        </p>
        <label className="field-label">
          Filter archived queries
          <input
            data-autofocus
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Connection, file, or category…"
          />
        </label>
        <label className="field-label">
          Archived query
          <select value={selected} onChange={(e) => setSelected(e.target.value)}>
            <option value="">Choose an archived file…</option>
            {(entries ?? [])
              .filter((entry) =>
                `${entry.category} ${entry.title}`.toLowerCase().includes(filter.toLowerCase()),
              )
              .map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.category} · {entry.title}
                </option>
              ))}
          </select>
        </label>
        {error && (
          <p role="alert" className="error-message">
            {error}
          </p>
        )}
        {!entries && !error && <p role="status">Loading archive…</p>}
        {entries?.length === 0 && <p>No queries have been imported.</p>}
        {selected && content === null && !error && <p role="status">Loading SQL…</p>}
        {content !== null && (
          <textarea
            aria-label="Archived SQL"
            readOnly
            value={content}
            spellCheck={false}
            className="query-archive-content"
          />
        )}
      </div>
      <div className="modal-actions">
        <button onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
