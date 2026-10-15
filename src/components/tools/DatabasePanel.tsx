import { useCallback, useEffect, useState } from 'react';
import { asError } from '../../model/document-session';
import { Modal } from '../Modal';
import { ConnectionDialog } from './ConnectionDialog';
import { RedisBrowser } from './RedisBrowser';
import { QueryArchive } from './QueryArchive';
import { api } from '../../api';
import { connectionApi, SELECTED_CONNECTION_KEY, toolRequest, type Connection } from './tool-api';
function chooseSelected(items: Connection[], current: string, saved: string | null) {
  if (current && items.some((item) => item.id === current)) return current;
  if (saved && items.some((item) => item.id === saved)) return saved;
  return '';
}
export function DatabasePanel({
  dirty,
  onOpenConsole,
  onRemoveConsole,
  onResultsHost,
  requestedConnection,
}: {
  dirty: boolean;
  onOpenConsole(connection: Connection): void;
  onRemoveConsole(id: string): Promise<boolean>;
  onResultsHost(id: string, host: HTMLDivElement | null): void;
  requestedConnection: { id: string } | null;
}) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [selected, setSelected] = useState('');
  const [showArchive, setShowArchive] = useState(false);
  const [editing, setEditing] = useState<Connection | 'new' | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const [generation, setGeneration] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    let requestGeneration = 0;
    const refresh = () => {
      const request = ++requestGeneration;
      Promise.all([connectionApi.list(), api.getSetting<string>(SELECTED_CONNECTION_KEY)])
        .then(([items, saved]) => {
          if (!current || request !== requestGeneration) return;
          setConnections(items);
          setSelected((value) => chooseSelected(items, value, saved));
        })
        .catch((e) => {
          if (current && request === requestGeneration) setError(asError(e).message);
        });
    };
    refresh();
    window.addEventListener('zwip:connections-changed', refresh);
    return () => {
      current = false;
      window.removeEventListener('zwip:connections-changed', refresh);
    };
  }, []);
  function selectConnection(id: string) {
    setSelected(id);
    setError('');
    void api.setSetting(SELECTED_CONNECTION_KEY, id).catch((e) => setError(asError(e).message));
  }
  const connection = connections.find((item) => item.id === selected);
  useEffect(() => {
    if (connection && connection.kind !== 'redis') onOpenConsole(connection);
  }, [connection, onOpenConsole]);
  const resultsRef = useCallback(
    (host: HTMLDivElement | null) => {
      onResultsHost(selected, host);
    },
    [selected, onResultsHost],
  );
  useEffect(() => {
    if (!requestedConnection) return;
    setSelected(requestedConnection.id);
  }, [requestedConnection]);
  async function saved(items: Connection[], id: string) {
    try {
      if (connection)
        await toolRequest(connection.kind === 'redis' ? 'redis' : 'sql', 'disconnect', {
          connectionId: connection.id,
        });
    } catch {
      /* An unavailable worker has no connection to release. */
    }
    setConnections(items);
    selectConnection(id);
    const next = items.find((item) => item.id === id);
    if (next && next.kind !== 'redis') onOpenConsole(next);
    setGeneration((value) => value + 1);
    setEditing(null);
    setError('');
  }
  async function remove() {
    if (!connection) return;
    setBusy(true);
    setError('');
    try {
      try {
        await toolRequest(connection.kind === 'redis' ? 'redis' : 'sql', 'disconnect', {
          connectionId: connection.id,
        });
      } catch {
        /* Connection metadata can be removed while a worker is unavailable. */
      }
      if (!(await onRemoveConsole(connection.id)))
        throw new Error('Cannot close the SQL console; the saved connection was retained.');
      const items = await connectionApi.delete(connection.id);
      setConnections(items);
      selectConnection('');
      setDeleting(false);
    } catch (e) {
      setError(asError(e).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="database-panel" aria-label="Database tools">
      <div className="connection-toolbar">
        <select
          aria-label="Saved database connection"
          disabled={dirty}
          value={selected}
          onChange={(e) => selectConnection(e.target.value)}
        >
          <option value="">Choose a connection…</option>
          {connections.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} · {item.kind}
            </option>
          ))}
        </select>
        <button disabled={dirty} onClick={() => setEditing('new')}>
          New…
        </button>
        <button
          disabled={!connection || dirty}
          onClick={() => connection && setEditing(connection)}
        >
          Edit…
        </button>
        <button disabled={!connection || dirty} onClick={() => setDeleting(true)}>
          Remove…
        </button>
        <button onClick={() => setShowArchive(true)}>Imported queries…</button>
      </div>
      {showArchive && <QueryArchive onClose={() => setShowArchive(false)} />}
      {dirty && (
        <p className="panel-footnote">Apply or discard pending row edits to change connections.</p>
      )}
      {error && (
        <p role="alert" className="inline-notice error-message">
          {error}
        </p>
      )}
      {connection ? (
        connection.kind === 'redis' ? (
          <RedisBrowser key={`${connection.id}:${generation}`} connection={connection} />
        ) : (
          <>
            <div className="tool-section-title">
              <button onClick={() => onOpenConsole(connection)}>Open SQL console</button>
            </div>
            <div className="sql-results-host" ref={resultsRef} />
          </>
        )
      ) : (
        <div className="empty-note">
          <p>Connect to SQL Server, MySQL, PostgreSQL, SQLite, or Redis.</p>
          <p>Install and enable the SQL or Redis package to browse data.</p>
        </div>
      )}
      {editing && (
        <ConnectionDialog
          initial={editing === 'new' ? undefined : editing}
          onSave={saved}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && connection && (
        <Modal
          title="Remove saved connection?"
          onClose={() => {
            if (!busy) setDeleting(false);
          }}
        >
          <div className="modal-body">
            <p>
              Remove {connection.name} and its saved credential. The database remains untouched.
            </p>
            {error && (
              <p role="alert" className="error-message">
                {error}
              </p>
            )}
          </div>
          <div className="modal-actions">
            <button disabled={busy} onClick={() => setDeleting(false)}>
              Cancel
            </button>
            <button className="danger" disabled={busy} onClick={() => void remove()}>
              Remove connection
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
