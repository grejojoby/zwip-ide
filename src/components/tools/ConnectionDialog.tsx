import { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { Modal } from '../Modal';
import { asError } from '../../model/document-session';
import { connectionApi, type Connection, type ConnectionKind } from './tool-api';
const ports = { mysql: 3306, postgres: 5432, redis: 6379, sqlite: 0 };
export function ConnectionDialog({
  initial,
  onSave,
  onClose,
}: {
  initial?: Connection;
  onSave(connections: Connection[], id: string): void | Promise<void>;
  onClose(): void;
}) {
  const [kind, setKind] = useState<ConnectionKind>(initial?.kind ?? 'postgres');
  const [name, setName] = useState(initial?.name ?? '');
  const [host, setHost] = useState(initial?.config.host ?? '127.0.0.1');
  const [port, setPort] = useState(initial?.config.port ?? ports[kind]);
  const [database, setDatabase] = useState(initial?.config.database ?? '');
  const [username, setUsername] = useState(initial?.config.username ?? '');
  const [path, setPath] = useState(initial?.config.path ?? '');
  const [tls, setTls] = useState(initial?.config.tls ?? true);
  const [password, setPassword] = useState('');
  const [replacePassword, setReplacePassword] = useState(!initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setBusy(true);
    setError('');
    try {
      const id = initial?.id ?? crypto.randomUUID();
      const config = kind === 'sqlite' ? { path } : { host, port, database, username, tls };
      const connections = await connectionApi.save(
        { id, kind, name: name.trim(), config },
        kind === 'sqlite' || !replacePassword ? undefined : password,
      );
      setPassword('');
      await onSave(connections, id);
    } catch (e) {
      setError(asError(e).message);
    } finally {
      setBusy(false);
    }
  }
  async function chooseFile() {
    try {
      const result = await open({ title: 'Open SQLite database', multiple: false });
      if (result) setPath(result);
    } catch (e) {
      setError(asError(e).message);
    }
  }
  return (
    <Modal
      title={initial ? 'Edit connection' : 'New database connection'}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="modal-body connection-form">
          <label className="field-label">
            Name
            <input
              data-autofocus
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Connection name"
            />
          </label>
          <label className="field-label">
            Database
            <select
              value={kind}
              onChange={(e) => {
                const next = e.target.value as ConnectionKind;
                setKind(next);
                setPort(ports[next]);
              }}
            >
              {(['postgres', 'mysql', 'sqlite', 'redis'] as const).map((item) => (
                <option key={item} value={item}>
                  {item === 'postgres'
                    ? 'PostgreSQL'
                    : item === 'mysql'
                      ? 'MySQL'
                      : item === 'sqlite'
                        ? 'SQLite'
                        : 'Redis'}
                </option>
              ))}
            </select>
          </label>
          {kind === 'sqlite' ? (
            <label className="field-label full-width">
              Database file
              <div className="input-with-button">
                <input
                  required
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="/path/to/database.sqlite"
                />
                <button type="button" onClick={() => void chooseFile()}>
                  Browse…
                </button>
              </div>
            </label>
          ) : (
            <>
              <label className="field-label">
                Host
                <input required value={host} onChange={(e) => setHost(e.target.value)} />
              </label>
              <label className="field-label">
                Port
                <input
                  required
                  type="number"
                  min={1}
                  max={65535}
                  value={port}
                  onChange={(e) => setPort(Number(e.target.value))}
                />
              </label>
              <label className="field-label">
                {kind === 'redis' ? 'Database index' : 'Database name'}
                <input
                  value={database}
                  onChange={(e) => setDatabase(e.target.value)}
                  placeholder={kind === 'redis' ? '0' : 'Database'}
                />
              </label>
              <label className="field-label">
                Username
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="off"
                />
              </label>
              <div className="full-width">
                {initial && (
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={replacePassword}
                      onChange={(e) => setReplacePassword(e.target.checked)}
                    />
                    Replace saved password
                  </label>
                )}
                <label className="field-label">
                  Password
                  <input
                    type="password"
                    disabled={!replacePassword}
                    value={password}
                    onChange={(e) => {
                      setReplacePassword(true);
                      setPassword(e.target.value);
                    }}
                    autoComplete="new-password"
                    placeholder={
                      initial && !replacePassword ? 'Saved in macOS Keychain' : 'Password'
                    }
                  />
                </label>
                <label className="checkbox-label">
                  <input type="checkbox" checked={tls} onChange={(e) => setTls(e.target.checked)} />
                  Use TLS with server verification
                </label>
                <p className="muted">Passwords are stored in macOS Keychain.</p>
              </div>
            </>
          )}
          {error && (
            <p className="full-width error-message" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !name.trim()}>
            {busy ? 'Saving…' : 'Save connection'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
