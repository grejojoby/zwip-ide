import { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { Modal } from '../Modal';
import { asError } from '../../model/document-session';
import { deploymentRequest } from '../../model/deployment-api';
import type { DeploymentServer } from '../../model/deployment-contracts';
const sections = ['Connection', 'Mappings', 'Exclusions', 'Options'] as const;
export function ServerEditor({
  root,
  initial,
  onSave,
  onClose,
}: {
  root: string;
  initial: DeploymentServer;
  onSave(server: DeploymentServer, secret: string, remember: boolean): Promise<void>;
  onClose(): void;
}) {
  const [server, setServer] = useState(initial);
  const [section, setSection] = useState<(typeof sections)[number]>('Connection');
  const [secret, setSecret] = useState('');
  const [remember, setRemember] = useState(!!initial.credentialId);
  const [key, setKey] = useState<{ fingerprint: string; algorithm: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  function field<K extends keyof DeploymentServer>(name: K, value: DeploymentServer[K]) {
    setServer((previous) => ({
      ...previous,
      [name]: value,
      ...((name === 'host' || name === 'port') && value !== previous[name]
        ? { fingerprint: '' }
        : {}),
    }));
    if (name === 'host' || name === 'port') setKey(null);
    setNote('');
  }
  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNote('');
    try {
      await operation();
    } catch (cause) {
      setError(asError(cause).message);
    } finally {
      setBusy(false);
    }
  }
  const textField = (
    label: string,
    name: 'name' | 'host' | 'username' | 'root' | 'keyPath',
    placeholder?: string,
  ) => (
    <label className="field-label">
      {label}
      <input
        required
        value={server[name]}
        placeholder={placeholder}
        onChange={(event) => field(name, event.target.value)}
      />
    </label>
  );
  return (
    <Modal
      title={initial.name ? `Configure ${initial.name}` : 'New SFTP server'}
      wide
      dismissible={!busy}
      onClose={onClose}
    >
      <form
        className="deployment-editor"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            if (!server.fingerprint)
              throw new Error('Review and trust the server key before saving.');
            if (server.auth === 'password' && !secret && !server.credentialId && !initial.name)
              throw new Error('Enter a password or choose another authentication method.');
            await onSave(server, secret, remember);
            setSecret('');
          });
        }}
      >
        <div className="deployment-sections" aria-label="Server configuration sections">
          {sections.map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={section === name}
              onClick={() => setSection(name)}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="modal-body">
          {error && (
            <p role="alert" className="error-message">
              {error}
            </p>
          )}
          {note && <p role="status">{note}</p>}
          <fieldset className="deployment-fields" disabled={busy}>
            <legend className="sr-only">{section}</legend>
            {section === 'Connection' && (
              <>
                {textField('Name', 'name', 'Staging')}
                {textField('Host', 'host', 'sftp.example.com')}
                <label className="field-label">
                  Port
                  <input
                    type="number"
                    min="1"
                    max="65535"
                    required
                    value={server.port}
                    onChange={(event) => field('port', Number(event.target.value))}
                  />
                </label>
                {textField('Username', 'username')}
                <label className="field-label">
                  Authentication
                  <select
                    value={server.auth}
                    onChange={(event) => {
                      setServer((previous) => ({
                        ...previous,
                        auth: event.target.value as DeploymentServer['auth'],
                        credentialId: undefined,
                      }));
                      setSecret('');
                    }}
                  >
                    <option value="agent">SSH agent</option>
                    <option value="key">Private key</option>
                    <option value="password">Password</option>
                  </select>
                </label>
                {server.auth === 'key' && (
                  <label className="field-label">
                    Private key
                    <div className="input-with-button">
                      <input
                        required
                        value={server.keyPath}
                        onChange={(event) => field('keyPath', event.target.value)}
                      />
                      <button
                        type="button"
                        onClick={() =>
                          void run(async () => {
                            const path = await open({
                              title: 'Choose SSH private key',
                              multiple: false,
                            });
                            if (path) field('keyPath', path);
                          })
                        }
                      >
                        Browse…
                      </button>
                    </div>
                  </label>
                )}
                {server.auth !== 'agent' && (
                  <>
                    <label className="field-label">
                      {server.auth === 'password' ? 'Password' : 'Key passphrase'}
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={secret}
                        onChange={(event) => setSecret(event.target.value)}
                        placeholder={
                          server.credentialId
                            ? 'Leave blank to keep the saved credential'
                            : 'Used only for this session unless saved'
                        }
                      />
                    </label>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={remember}
                        onChange={(event) => setRemember(event.target.checked)}
                      />
                      Save new credential in macOS Keychain
                    </label>
                    {server.credentialId && (
                      <button
                        type="button"
                        onClick={() => {
                          field('credentialId', undefined);
                          setRemember(false);
                        }}
                      >
                        Forget saved credential when saving
                      </button>
                    )}
                  </>
                )}
                {textField('Remote root', 'root', '. for remote home, or /var/www')}
                <div className="deployment-full">
                  <p className="muted">
                    Mappings and remote browsing start at this root. An SSH agent uses
                    SSH_AUTH_SOCK; private key files stay on your computer.
                  </p>
                  <p>
                    Trusted host key:{' '}
                    <code className="deployment-fingerprint">
                      {server.fingerprint || 'Not verified'}
                    </code>
                  </p>
                  <div className="deployment-toolbar">
                    <button
                      type="button"
                      onClick={() =>
                        void run(async () => {
                          setKey(await deploymentRequest(root, 'host.probe', { server }));
                        })
                      }
                    >
                      Review server key
                    </button>
                    <button
                      type="button"
                      disabled={!server.fingerprint}
                      onClick={() =>
                        void run(async () => {
                          const result = await deploymentRequest<{ root: string }>(
                            root,
                            'connection.test',
                            { server, ...(secret ? { secret } : {}) },
                            server,
                          );
                          setNote(`Connected successfully. Remote root: ${result.root}`);
                        })
                      }
                    >
                      Test connection
                    </button>
                  </div>
                  {key && (
                    <div className="deployment-trust" role="region" aria-label="Server key review">
                      <strong>{key.algorithm}</strong>
                      <code className="deployment-fingerprint">{key.fingerprint}</code>
                      <p>
                        Verify this fingerprint with the server administrator before trusting it. A
                        changed key can identify a different server.
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          field('fingerprint', key.fingerprint);
                          setKey(null);
                        }}
                      >
                        Trust this server key
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
            {section === 'Mappings' && (
              <div className="deployment-full">
                <p>
                  Map local folders to paths beneath the remote root. The most specific local
                  mapping wins.
                </p>
                {server.mappings.map((mapping, index) => (
                  <div className="deployment-mapping" key={index}>
                    <label className="field-label">
                      Local folder
                      <input
                        required
                        value={mapping.local}
                        onChange={(event) =>
                          field(
                            'mappings',
                            server.mappings.map((item, i) =>
                              i === index ? { ...item, local: event.target.value } : item,
                            ),
                          )
                        }
                        placeholder=". or public"
                      />
                    </label>
                    <label className="field-label">
                      Deployment path
                      <input
                        value={mapping.remote}
                        onChange={(event) =>
                          field(
                            'mappings',
                            server.mappings.map((item, i) =>
                              i === index ? { ...item, remote: event.target.value } : item,
                            ),
                          )
                        }
                        placeholder="Relative to remote root"
                      />
                    </label>
                    <button
                      type="button"
                      aria-label={`Remove mapping ${index + 1}`}
                      disabled={server.mappings.length === 1}
                      onClick={() =>
                        field(
                          'mappings',
                          server.mappings.filter((_, i) => i !== index),
                        )
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => field('mappings', [...server.mappings, { local: '', remote: '' }])}
                >
                  Add mapping
                </button>
              </div>
            )}
            {section === 'Exclusions' && (
              <>
                <label className="field-label">
                  Local excluded paths
                  <textarea
                    rows={7}
                    value={server.excludedLocal.join('\n')}
                    onChange={(event) =>
                      field('excludedLocal', event.target.value.split('\n').filter(Boolean))
                    }
                    placeholder="One workspace-relative subtree per line"
                  />
                </label>
                <label className="field-label">
                  Remote excluded paths
                  <textarea
                    rows={7}
                    value={server.excludedRemote.join('\n')}
                    onChange={(event) =>
                      field('excludedRemote', event.target.value.split('\n').filter(Boolean))
                    }
                    placeholder="One subtree relative to remote root per line"
                  />
                </label>
                <label className="field-label deployment-full">
                  Exclude names
                  <input
                    value={server.excludeNames}
                    onChange={(event) => field('excludeNames', event.target.value)}
                  />
                  <span className="muted">
                    Separate patterns with semicolons. * matches any characters; ? matches one.
                    Matching folders exclude their contents.
                  </span>
                </label>
                <p className="muted deployment-full">
                  Local and remote symlinks are not followed. The configured private key is always
                  excluded from uploads.
                </p>
              </>
            )}
            {section === 'Options' && (
              <>
                <label className="checkbox-label deployment-full">
                  <input
                    type="checkbox"
                    checked={server.preserveTimestamps}
                    onChange={(event) => field('preserveTimestamps', event.target.checked)}
                  />
                  Preserve saved file timestamps
                </label>
                <label className="field-label">
                  File permissions
                  <input
                    value={server.fileMode}
                    maxLength={3}
                    pattern="[0-7]{3}|"
                    placeholder="Keep existing, otherwise 644"
                    onChange={(event) => field('fileMode', event.target.value)}
                  />
                </label>
                <label className="field-label">
                  New folder permissions
                  <input
                    value={server.directoryMode}
                    maxLength={3}
                    pattern="[0-7]{3}|"
                    placeholder="755"
                    onChange={(event) => field('directoryMode', event.target.value)}
                  />
                </label>
                <p className="muted deployment-full">
                  Uploads stage to private temporary files, then rename into place. Replacing an
                  existing file requires the server's OpenSSH atomic rename extension.
                  Upload-on-save is configured for the default server in the Deployment window.
                </p>
              </>
            )}
          </fieldset>
        </div>
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Working…' : 'Save server'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
