import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { asError } from '../model/document-session';
import { Modal } from './Modal';

interface ServerStatus {
  running: boolean;
  directory?: string;
  url?: string;
  warning?: string;
}
export function LiveServer({ onClose, onPackages }: { onClose(): void; onPackages(): void }) {
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [directory, setDirectory] = useState('.');
  const [port, setPort] = useState('5500');
  const [server, setServer] = useState<ServerStatus>({ running: false });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const revision = useRef(0);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    let reading = false;
    async function refresh() {
      if (inFlight.current || reading) return;
      reading = true;
      const version = revision.current;
      const current = () => active && revision.current === version;
      try {
        const packages = await api.packages();
        if (!current()) return;
        const enabled = packages.some((item) => item.id === 'live-server' && item.enabled);
        setAvailable(enabled);
        if (enabled) {
          const status = await api.toolRequest<ServerStatus>('live-server', 'status');
          if (!current()) return;
          setServer(status);
          if (status.running) {
            setDirectory(status.directory ?? '.');
            setPort(new URL(status.url!).port);
          }
        } else setServer({ running: false });
      } catch (cause) {
        if (current()) setError(asError(cause).message);
      } finally {
        reading = false;
        if (current()) setLoading(false);
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      mounted.current = false;
      active = false;
      clearInterval(timer);
    };
  }, []);

  async function action(method: 'start' | 'stop' | 'open') {
    if (inFlight.current) return;
    inFlight.current = true;
    revision.current++;
    setBusy(true);
    setError('');
    try {
      const status =
        method === 'start'
          ? await api.toolRequest<ServerStatus>('live-server', method, {
              directory,
              port: Number(port),
            })
          : await api.toolRequest<ServerStatus>('live-server', method);
      if (!mounted.current) return;
      setServer(status);
      if (method === 'start') await api.toolRequest('live-server', 'open');
    } catch (cause) {
      if (mounted.current) setError(asError(cause).message);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <Modal title="Live Server" onClose={onClose}>
      <div className="modal-body">
        <p className="muted">
          Preview static HTML, CSS and JavaScript on localhost. Pages reload after saved changes.
        </p>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        {loading ? (
          <p role="status">Checking Live Server…</p>
        ) : !available ? (
          <>
            <p>Install and enable the optional Live Server package to start a web server.</p>
            <button onClick={onPackages}>Manage packages</button>
          </>
        ) : (
          <form
            id="live-server-form"
            onSubmit={(event) => {
              event.preventDefault();
              void action('start');
            }}
          >
            <label className="field-label">
              Folder
              <input
                value={directory}
                required
                disabled={server.running || busy}
                onChange={(event) => setDirectory(event.target.value)}
                data-autofocus
              />
            </label>
            <p className="muted">Relative to this workspace, for example . or public.</p>
            <label className="field-label">
              Port
              <input
                type="number"
                value={port}
                required
                min="0"
                max="65535"
                step="1"
                disabled={server.running || busy}
                onChange={(event) => setPort(event.target.value)}
              />
            </label>
            <p className="muted">Use 0 to choose an available port automatically.</p>
            <p role="status">{server.running ? `Running at ${server.url}` : 'Server stopped'}</p>
            {server.warning && (
              <p role="alert" className="error-message">
                {server.warning}
              </p>
            )}
            <p className="muted">
              Serves files from the chosen folder. Backend code needs its own server. Closing this
              dialog keeps Live Server running.
            </p>
          </form>
        )}
      </div>
      <div className="modal-actions">
        {!loading &&
          available &&
          (server.running ? (
            <>
              <button disabled={busy} onClick={() => void action('open')}>
                Open in browser
              </button>
              <button disabled={busy} onClick={() => void action('stop')}>
                Stop server
              </button>
            </>
          ) : (
            <button className="primary" form="live-server-form" disabled={busy}>
              {busy ? 'Starting…' : 'Start server'}
            </button>
          ))}
        <button onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}
