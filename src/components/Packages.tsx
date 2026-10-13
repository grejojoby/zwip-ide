import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { api } from '../api';
import type { PackageCatalog, PackageInstallProgress, PackageState } from '../contracts';
import { asError } from '../model/document-session';
import { Modal } from './Modal';
export function Packages({ onClose }: { onClose(): void }) {
  const [packages, setPackages] = useState<PackageState[]>([]);
  const [catalog, setCatalog] = useState<PackageCatalog | null>(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);
  const [progress, setProgress] = useState<PackageInstallProgress | null>(null);
  useEffect(() => {
    api
      .packages()
      .then(setPackages)
      .catch((e) => setError(asError(e).message))
      .finally(() => setBusy(false));
    // The built-in catalog loads automatically; failures (e.g. offline) stay quiet until retried.
    api
      .packageCatalog()
      .then((result) => {
        setCatalog(result);
        setUrl(result.url);
      })
      .catch(() => undefined);
  }, []);
  async function action(operation: () => Promise<PackageState[]>) {
    setBusy(true);
    setError('');
    try {
      setPackages(await operation());
    } catch (e) {
      setError(asError(e).message);
    } finally {
      setBusy(false);
    }
  }
  // Poll the backend while a catalog package downloads and installs.
  useEffect(() => {
    if (!installing) return;
    let active = true;
    const timer = setInterval(() => {
      api
        .packageInstallProgress()
        .then((all) => {
          if (active) setProgress(all[installing] ?? null);
        })
        .catch(() => undefined);
    }, 200);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [installing]);
  async function download(id: string, version: string) {
    setInstalling(id);
    setProgress(null);
    try {
      await action(() => api.installCatalogPackage(id, version));
    } finally {
      setInstalling(null);
      setProgress(null);
    }
  }
  const latest = (id: string) => catalog?.packages.filter((item) => item.id === id).at(-1);
  async function install(directory: boolean) {
    try {
      const path = await open({
        title: directory ? 'Select a package directory' : 'Install a package archive',
        multiple: false,
        directory,
        ...(directory ? {} : { filters: [{ name: 'Package archive', extensions: ['zip'] }] }),
      });
      if (path) await action(() => api.installPackage(path));
    } catch (e) {
      setError(asError(e).message);
    }
  }
  async function loadCatalog() {
    setBusy(true);
    setError('');
    try {
      if (url.trim()) await api.configureCatalog(url.trim());
      const result = await api.packageCatalog();
      setCatalog(result);
      setUrl(result.url);
    } catch (e) {
      setError(asError(e).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Language & tool packages" onClose={onClose}>
      <div className="modal-body">
        <p className="muted">
          Install the capabilities you need. Enabled packages start when used.
        </p>
        {error && (
          <p role="alert" className="error-message">
            {error}
          </p>
        )}
        <div className="package-list">
          {packages.map((item) => (
            <article className="package-item" key={item.id}>
              <div>
                <h3>
                  {item.name}
                  <small>{item.version}</small>
                </h3>
                <p>{item.description}</p>
                <span className="muted">
                  {item.running
                    ? 'Running'
                    : item.enabled
                      ? 'Enabled'
                      : item.installed
                        ? 'Installed'
                        : 'Not installed'}
                </span>
                {item.error && <p className="error-message">{item.error}</p>}
                {installing === item.id && <InstallProgress progress={progress} />}
              </div>
              <div className="package-actions">
                {(() => {
                  const available = latest(item.id);
                  if (!available || (item.installed && available.version === item.version))
                    return null;
                  return (
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => void download(item.id, available.version)}
                    >
                      {installing === item.id
                        ? 'Installing…'
                        : item.installed
                          ? `Update to ${available.version}`
                          : 'Download'}
                    </button>
                  );
                })()}
                <button
                  disabled={busy || !item.installed}
                  onClick={() => void action(() => api.enablePackage(item.id, !item.enabled))}
                >
                  {item.enabled ? 'Disable' : 'Enable'}
                </button>
                {item.enabled && item.id !== 'react-next' && (
                  <button
                    disabled={busy}
                    onClick={() => void action(() => api.restartPackage(item.id))}
                  >
                    Restart
                  </button>
                )}
                {item.installed && (
                  <button
                    disabled={busy}
                    onClick={() => void action(() => api.rollbackPackage(item.id))}
                  >
                    Previous version
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
        <details>
          <summary>Curated catalog</summary>
          <p className="muted">Use an HTTPS catalog you trust to supply executable packages.</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void loadCatalog();
            }}
            className="input-with-button"
          >
            <input
              aria-label="Package catalog URL"
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="HTTPS catalog URL"
            />
            <button disabled={busy}>Load catalog</button>
          </form>
          {catalog?.packages
            .filter((item) => !packages.some((known) => known.id === item.id))
            .map((item) => (
              <article className="package-item" key={`${item.id}-${item.version}`}>
                <div>
                  <h3>
                    {item.name}
                    <small>{item.version}</small>
                  </h3>
                  <p>
                    {item.platform} · {item.architecture}
                  </p>
                </div>
                <button
                  disabled={
                    busy ||
                    packages.some(
                      (installed) => installed.id === item.id && installed.version === item.version,
                    )
                  }
                  onClick={() => void download(item.id, item.version)}
                >
                  {installing === item.id ? 'Installing…' : 'Download'}
                </button>
                {installing === item.id && <InstallProgress progress={progress} />}
              </article>
            ))}
        </details>
        {busy && !installing && <p role="status">Working…</p>}
      </div>
      <div className="modal-actions">
        <button disabled={busy} onClick={() => void install(false)}>
          Install archive…
        </button>
        <button disabled={busy} onClick={() => void install(true)}>
          Install directory…
        </button>
        <button className="primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}

function InstallProgress({ progress }: { progress: PackageInstallProgress | null }) {
  const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (progress?.phase === 'downloading')
    return (
      <div className="install-progress" role="status">
        {progress.total ? (
          <progress value={progress.received} max={progress.total} />
        ) : (
          <progress />
        )}
        <span>
          Downloading {mib(progress.received)}
          {progress.total ? ` of ${mib(progress.total)}` : ''}
        </span>
      </div>
    );
  return (
    <div className="install-progress" role="status">
      <progress />
      <span>{progress?.phase === 'installing' ? 'Verifying and installing…' : 'Connecting…'}</span>
    </div>
  );
}
