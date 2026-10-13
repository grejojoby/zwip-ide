import { useEffect, useState } from 'react';
import type { HistoryEntry } from '../contracts';
import { api } from '../api';
import { asError } from '../model/document-session';
export function HistoryPanel({
  path,
  onRestore,
}: {
  path: string;
  onRestore(content: string): void;
}) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [selected, setSelected] = useState<HistoryEntry | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setSelected(null);
    setError('');
    api
      .history(path)
      .then((result) => {
        if (active) setEntries(result);
      })
      .catch((e) => {
        if (active) setError(asError(e).message);
      });
    return () => {
      active = false;
    };
  }, [path]);
  return (
    <section className="history-panel" aria-label="Local History">
      <div className="results-summary">
        <strong>Local History</strong>
        <span>{path.split('/').pop()}</span>
        <div className="spacer" />
        <button disabled={!selected} onClick={() => selected && onRestore(selected.content)}>
          Restore to editor
        </button>
      </div>
      {error && (
        <p role="alert" className="error-message inline-notice">
          {error}
        </p>
      )}
      <div className="history-content">
        <div className="history-entries">
          {entries.map((entry) => (
            <button
              key={entry.id}
              className={selected?.id === entry.id ? 'selected' : ''}
              onClick={() => setSelected(entry)}
            >
              {new Date(
                entry.timestamp > 1e12 ? entry.timestamp : entry.timestamp * 1000,
              ).toLocaleString()}
            </button>
          ))}
          {!entries.length && <p className="empty-note">No saved revisions yet.</p>}
        </div>
        <pre className="history-preview">
          {selected?.content ?? 'Select a saved revision to preview it.'}
        </pre>
      </div>
    </section>
  );
}
