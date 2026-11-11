import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { Modal } from '../Modal';
import { asError } from '../../model/document-session';
import { deploymentAutoKey, deploymentRequest } from '../../model/deployment-api';
import {
  newDeploymentServer,
  type DeploymentJob,
  type DeploymentPlan,
  type DeploymentRemoteEntry,
  type DeploymentServer,
  type DeploymentSettings,
} from '../../model/deployment-contracts';
import { ServerEditor } from './ServerEditor';
import { UploadPreview } from './UploadPreview';
import './deployment.css';
export function Deployment({
  root,
  currentPath,
  selection,
  onClose,
  onPackages,
}: {
  root: string;
  currentPath?: string;
  selection?: string[];
  onClose(): void;
  onPackages(): void;
}) {
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<DeploymentSettings>({
    revision: 0,
    servers: [],
    defaultId: '',
    autoUpload: 'never',
  });
  const [selected, setSelected] = useState('');
  const [editing, setEditing] = useState<DeploymentServer | null>(null);
  const [view, setView] = useState<'remote' | 'preview' | 'transfers'>('remote');
  const [path, setPath] = useState(selection?.[0] ?? currentPath ?? '.');
  const [remotePath, setRemotePath] = useState('');
  const [entries, setEntries] = useState<DeploymentRemoteEntry[] | null>(null);
  const [remoteRoot, setRemoteRoot] = useState('');
  const [plan, setPlan] = useState<DeploymentPlan | null>(null);
  const [job, setJob] = useState<DeploymentJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [remove, setRemove] = useState(false);
  const mounted = useRef(false);
  const server = settings.servers.find((item) => item.id === selected);
  const activeJob = job?.status === 'running';
  useEffect(() => {
    let active = true;
    mounted.current = true;
    void (async () => {
      try {
        const packages = await api.packages();
        if (!active) return;
        const enabled = packages.some((item) => item.id === 'deployment' && item.enabled);
        setAvailable(enabled);
        if (enabled) {
          const result = await deploymentRequest<DeploymentSettings>(root, 'settings.get');
          if (active) {
            setSettings(result);
            setSelected(result.defaultId || result.servers[0]?.id || '');
          }
        }
      } catch (cause) {
        if (active) setError(asError(cause).message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [root]);
  useEffect(() => {
    if (!available) return;
    let active = true,
      reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const value = await deploymentRequest<DeploymentJob | null>(root, 'transfer.status');
        if (active) setJob(value);
      } catch (cause) {
        if (active) setError(asError(cause).message);
      } finally {
        reading = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [root, available]);
  async function run(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (cause) {
      if (mounted.current) setError(asError(cause).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function save(
    next: DeploymentSettings,
    sessionSecret?: { serverId: string; secret: string },
  ) {
    const result = await deploymentRequest<DeploymentSettings>(root, 'settings.save', {
      settings: next,
      expectedRevision: settings.revision,
      ...(sessionSecret ? { sessionSecret } : {}),
    });
    setSettings(result);
    setPlan(null);
    const target = result.servers.find((item) => item.id === result.defaultId);
    try {
      await api.setSetting(
        deploymentAutoKey(root),
        result.autoUpload === 'onSave' && target
          ? { serverId: target.id, credentialId: target.credentialId }
          : null,
      );
    } catch {
      setError(
        'Server settings were saved, but the automatic-upload preference could not be updated. Reopen Deployment and select the upload mode again.',
      );
    }
    window.dispatchEvent(new Event('zwip:deployment-changed'));
    return result;
  }
  async function saveServer(draft: DeploymentServer, secret: string, remember: boolean) {
    const previous = settings.servers.find((item) => item.id === draft.id);
    const updated = { ...draft };
    if (secret) {
      if (remember) {
        const created = crypto.randomUUID();
        await api.setPackageCredential('deployment', created, secret, root);
        updated.credentialId = created;
      } else delete updated.credentialId;
    }
    try {
      await save(
        {
          ...settings,
          servers: settings.servers.some((item) => item.id === updated.id)
            ? settings.servers.map((item) => (item.id === updated.id ? updated : item))
            : [...settings.servers, updated],
          defaultId: settings.defaultId || updated.id,
        },
        secret && !remember ? { serverId: updated.id, secret } : undefined,
      );
    } catch (cause) {
      throw new Error('Could not confirm the settings save. Reopen Deployment before retrying.', {
        cause,
      });
    }
    if (previous?.credentialId && previous.credentialId !== updated.credentialId)
      await api
        .deletePackageCredential('deployment', previous.credentialId, root)
        .catch(() =>
          setError('Server saved, but its previous Keychain credential could not be removed.'),
        );
    setSelected(updated.id);
    setEditing(null);
    setEntries(null);
  }
  async function browse(path: string) {
    if (!server) return;
    const result = await deploymentRequest<{ root: string; entries: DeploymentRemoteEntry[] }>(
      root,
      'remote.list',
      { serverId: server.id, path },
      server,
    );
    if (mounted.current) {
      setEntries(result.entries);
      setRemotePath(path);
      setRemoteRoot(result.root);
      setView('remote');
    }
  }
  async function preview(paths: string[]) {
    if (!server) return;
    const result = await deploymentRequest<DeploymentPlan>(
      root,
      'upload.plan',
      { serverId: server.id, paths },
      server,
    );
    if (mounted.current) {
      setPlan(result);
      setView('preview');
    }
  }
  return (
    <>
      <Modal title="SFTP Deployment" wide onClose={onClose}>
        <div className="modal-body deployment-body">
          {error && (
            <p role="alert" className="error-message">
              {error}
            </p>
          )}
          {loading ? (
            <p role="status">Loading deployment settings…</p>
          ) : !available ? (
            <>
              <p>Install and enable the optional SFTP Deployment package to upload files.</p>
              <button onClick={onPackages}>Manage packages</button>
            </>
          ) : (
            <>
              <div className="deployment-toolbar">
                <label className="field-label deployment-server-select">
                  Deployment server
                  <select
                    aria-label="Deployment server"
                    value={selected}
                    disabled={busy}
                    onChange={(event) => {
                      setSelected(event.target.value);
                      setEntries(null);
                      setPlan(null);
                      setRemotePath('');
                      setError('');
                    }}
                  >
                    <option value="">Choose a server…</option>
                    {settings.servers.map((item) => (
                      <option value={item.id} key={item.id}>
                        {item.name}
                        {settings.defaultId === item.id ? ' · Default' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  disabled={busy || activeJob}
                  onClick={() => setEditing(newDeploymentServer(crypto.randomUUID()))}
                >
                  New server…
                </button>
                <button
                  disabled={!server || busy || activeJob}
                  onClick={() => server && setEditing(server)}
                >
                  Configure…
                </button>
                <button disabled={!server || busy || activeJob} onClick={() => setRemove(true)}>
                  Remove…
                </button>
              </div>
              {server ? (
                <>
                  <p className="muted">
                    {server.username}@{server.host}:{server.port} · Root {server.root}
                  </p>
                  <div className="deployment-toolbar">
                    <button
                      disabled={busy || activeJob || selected === settings.defaultId}
                      onClick={() =>
                        void run(async () => {
                          await save({ ...settings, defaultId: selected });
                        })
                      }
                    >
                      {selected === settings.defaultId ? 'Default server' : 'Use as default'}
                    </button>
                    <label className="field-label deployment-auto">
                      Upload changed files automatically
                      <select
                        aria-label="Automatic upload"
                        disabled={busy || activeJob || !settings.defaultId}
                        value={settings.autoUpload}
                        onChange={(event) =>
                          void run(async () => {
                            await save({
                              ...settings,
                              autoUpload: event.target.value as DeploymentSettings['autoUpload'],
                            });
                          })
                        }
                      >
                        <option value="never">Never</option>
                        <option value="onSave">After saving in Zwip, to the default server</option>
                      </select>
                    </label>
                  </div>
                  <div className="deployment-toolbar">
                    <label className="field-label deployment-local">
                      Local file or folder
                      <input
                        value={path}
                        disabled={busy}
                        onChange={(event) => setPath(event.target.value)}
                        placeholder="Workspace-relative path"
                      />
                    </label>
                    <button
                      disabled={busy || activeJob || !path.trim()}
                      onClick={() =>
                        void run(() =>
                          preview(selection && path === selection[0] ? selection : [path]),
                        )
                      }
                    >
                      Preview upload
                    </button>
                    <button
                      disabled={busy || activeJob || !currentPath}
                      onClick={() => void run(() => preview([currentPath!]))}
                    >
                      Current file
                    </button>
                    <button
                      disabled={busy || activeJob}
                      onClick={() =>
                        void run(() => preview(server.mappings.map((mapping) => mapping.local)))
                      }
                    >
                      All mapped files
                    </button>
                  </div>
                </>
              ) : (
                <p>Add a server, review its host key, and configure path mappings to begin.</p>
              )}
              <nav className="deployment-sections" aria-label="Deployment views">
                <button aria-pressed={view === 'remote'} onClick={() => setView('remote')}>
                  Remote files
                </button>
                <button
                  aria-pressed={view === 'preview'}
                  disabled={!plan}
                  onClick={() => setView('preview')}
                >
                  Upload preview
                </button>
                <button aria-pressed={view === 'transfers'} onClick={() => setView('transfers')}>
                  Transfers{activeJob ? ' · Running' : ''}
                </button>
              </nav>
              {view === 'remote' && (
                <section aria-label="Remote browser">
                  <div className="deployment-toolbar">
                    <button
                      disabled={busy || !server}
                      onClick={() => void run(() => browse(remotePath))}
                    >
                      {entries ? 'Refresh remote files' : 'Browse remote files'}
                    </button>
                    <button
                      disabled={busy || !remotePath}
                      onClick={() =>
                        void run(() => browse(remotePath.split('/').slice(0, -1).join('/')))
                      }
                    >
                      Up
                    </button>
                    <span className="deployment-remote-path">
                      {remoteRoot
                        ? `${remoteRoot}/${remotePath}`
                        : 'Connect to browse the configured remote root'}
                    </span>
                  </div>
                  {entries && (
                    <div className="deployment-table-scroll">
                      <table className="deployment-table">
                        <thead>
                          <tr>
                            <th>Name</th>
                            <th>Type</th>
                            <th>Size</th>
                            <th>Modified</th>
                          </tr>
                        </thead>
                        <tbody>
                          {entries.map((entry) => (
                            <tr key={entry.path}>
                              <td>
                                {entry.kind === 'directory' ? (
                                  <button
                                    disabled={busy}
                                    onClick={() => void run(() => browse(entry.path))}
                                  >
                                    {entry.name}/
                                  </button>
                                ) : (
                                  entry.name
                                )}
                              </td>
                              <td>{entry.kind}</td>
                              <td>
                                {entry.kind === 'file' ? `${entry.bytes.toLocaleString()} B` : '—'}
                              </td>
                              <td>{new Date(entry.modified).toLocaleString()}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {!entries.length && <p>This remote folder is empty.</p>}
                    </div>
                  )}
                </section>
              )}
              {view === 'preview' && plan && (
                <UploadPreview
                  key={plan.id}
                  plan={plan}
                  busy={busy || !!activeJob}
                  onCompare={(key) =>
                    deploymentRequest(root, 'remote.compare', { planId: plan.id, key }, server)
                  }
                  onUpload={(keys) =>
                    void run(async () => {
                      const next = await deploymentRequest<DeploymentJob>(
                        root,
                        'upload.start',
                        { planId: plan.id, keys },
                        server,
                      );
                      setJob(next);
                      setView('transfers');
                    })
                  }
                />
              )}
              {view === 'transfers' && (
                <section aria-label="Deployment transfers">
                  {job ? (
                    <>
                      <div className="deployment-toolbar">
                        <strong>
                          {job.serverName} · {job.status}
                        </strong>
                        {activeJob && (
                          <button
                            onClick={() =>
                              void run(async () => {
                                await deploymentRequest(root, 'transfer.cancel', { id: job.id });
                              })
                            }
                          >
                            Cancel upload
                          </button>
                        )}
                      </div>
                      <p>
                        {job.files.filter((file) => file.status === 'uploaded').length} uploaded ·{' '}
                        {job.files.filter((file) => file.status === 'unchanged').length} unchanged ·{' '}
                        {
                          job.files.filter(
                            (file) => file.status === 'failed' || file.status === 'unknown',
                          ).length
                        }{' '}
                        failed or uncertain ·{' '}
                        {job.files.filter((file) => file.status === 'cancelled').length} cancelled
                      </p>
                      <progress
                        aria-label="Upload progress"
                        value={job.files.reduce(
                          (sum, file) =>
                            sum + (file.status === 'unchanged' ? file.bytes : file.sent),
                          0,
                        )}
                        max={Math.max(
                          1,
                          job.files.reduce((sum, file) => sum + file.bytes, 0),
                        )}
                      />
                      <div className="deployment-transfer-log">
                        {job.files.map((file) => (
                          <div key={file.key}>
                            <strong>{file.status}</strong>{' '}
                            <span>
                              {file.local} → {file.remote}
                            </span>
                            <small>
                              {file.sent.toLocaleString()} / {file.bytes.toLocaleString()} B
                              {file.message ? ` · ${file.message}` : ''}
                            </small>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <p>No transfers in this workspace yet.</p>
                  )}
                </section>
              )}
              {busy && <p role="status">Working…</p>}
              <p className="muted">
                Only uploads are supported. Remote files are never deleted. Closing this window
                keeps active transfers running; disabling the package or changing workspace stops
                them.
              </p>
            </>
          )}
        </div>
        <div className="modal-actions">
          <button onClick={onClose}>Done</button>
        </div>
      </Modal>
      {editing && (
        <ServerEditor
          root={root}
          initial={editing}
          onSave={saveServer}
          onClose={() => setEditing(null)}
        />
      )}
      {remove && server && (
        <Modal title="Remove deployment server?" onClose={() => setRemove(false)}>
          <div className="modal-body">
            <p>Remove {server.name} and its saved credential? Remote files are kept.</p>
          </div>
          <div className="modal-actions">
            <button disabled={busy} onClick={() => setRemove(false)}>
              Cancel
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await save({
                    ...settings,
                    servers: settings.servers.filter((item) => item.id !== server.id),
                    ...(settings.defaultId === server.id
                      ? { defaultId: '', autoUpload: 'never' }
                      : {}),
                  });
                  setSelected('');
                  setRemove(false);
                  if (server.credentialId)
                    await api
                      .deletePackageCredential('deployment', server.credentialId, root)
                      .catch(() =>
                        setError(
                          'Server removed, but its Keychain credential could not be removed.',
                        ),
                      );
                })
              }
            >
              Remove server
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
