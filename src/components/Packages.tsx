import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { api } from '../api';
import type { PackageCatalog, PackageState } from '../contracts';
import { asError } from '../model/document-session';
import { Modal } from './Modal';
export function Packages({ onClose }: { onClose(): void }) {
  const [packages, setPackages] = useState<PackageState[]>([]);
  const [catalog, setCatalog] = useState<PackageCatalog | null>(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
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
              </div>
              <div className="package-actions">
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
        <details open>
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
          {catalog?.packages.map((item) => (
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
                onClick={() => void action(() => api.installCatalogPackage(item.id, item.version))}
              >
                Install
              </button>
            </article>
          ))}
        </details>
        {busy && <p role="status">Working…</p>}
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
