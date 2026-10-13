import { useMemo, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { api } from '../api';
import { asError } from '../model/document-session';
import type { IntelliJImportPreview } from '../model/intellij-import-contracts';
import { previewIntelliJKeymap } from '../model/intellij-keymap';
import { shortcutActions, shortcutLabel, type Shortcuts } from '../model/shortcuts';
import { Modal } from './Modal';
import { IntelliJRunImport } from './IntelliJRunImport';
import type { WorkspaceRunSession } from '../model/run-configurations';
import './intellij-import.css';

export function IntelliJImport({
  shortcuts,
  workspaceRoot,
  runSession,
  runOnly = false,
  onKeymap,
  onAppearance,
  onClose,
}: {
  shortcuts: Shortcuts;
  workspaceRoot?: string;
  runSession?: WorkspaceRunSession;
  /** Show only run/debug configurations, for opening the importer outside Settings. */
  runOnly?: boolean;
  onKeymap?(shortcuts: Shortcuts): void;
  onAppearance?(dark: boolean): void;
  onClose(): void;
}) {
  const [path, setPath] = useState('');
  const [projectRoot, setProjectRoot] = useState(workspaceRoot ?? '');
  const [preview, setPreview] = useState<IntelliJImportPreview | null>(null);
  const [keymap, setKeymap] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const keymapNames = preview
    ? [
        ...new Set([
          ...preview.keymaps.map((item) => item.name),
          ...(preview.activeKeymap ? [preview.activeKeymap] : []),
        ]),
      ]
    : [];
  const mapping = useMemo(
    () => (preview && keymap ? previewIntelliJKeymap(preview.keymaps, keymap, shortcuts) : null),
    [preview, keymap, shortcuts],
  );

  function invalidate() {
    setPreview(null);
    setSelected(new Set());
    setError('');
    setMessage('');
  }
  async function choose(directory: boolean, project = false) {
    if (busyRef.current) return;
    try {
      const chosen = await open({
        title: project ? 'Choose the original project directory' : 'Choose IntelliJ settings',
        directory,
        multiple: false,
        ...(directory
          ? {}
          : { filters: [{ name: 'IntelliJ settings', extensions: ['xml', 'zip'] }] }),
      });
      if (!chosen || typeof chosen !== 'string') return;
      invalidate();
      if (project) setProjectRoot(chosen);
      else setPath(chosen);
    } catch (e) {
      setError(asError(e).message);
    }
  }
  async function inspect() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    invalidate();
    try {
      const result = await api.previewIntelliJ(path.trim(), projectRoot.trim() || undefined);
      setPreview(result);
      setKeymap(result.activeKeymap ?? result.keymaps[0]?.name ?? '');
      setSelected(
        new Set(
          result.connections.filter((item) => item.status === 'ready').map((item) => item.id),
        ),
      );
    } catch (e) {
      setError(asError(e).message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function importConnections() {
    if (!preview || !selected.size || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await api.importIntelliJConnections(
        path.trim(),
        preview.fingerprint,
        [...selected],
        projectRoot.trim() || undefined,
      );
      const importedIds = new Set(selected);
      setPreview({
        ...preview,
        connections: preview.connections.map((item) =>
          importedIds.has(item.id)
            ? { ...item, status: 'duplicate', notes: [...item.notes, 'Already imported.'] }
            : item,
        ),
      });
      setSelected(new Set());
      setMessage(
        result.imported +
          ' connection' +
          (result.imported === 1 ? '' : 's') +
          ' saved. Open Database tools and edit a connection to enter its password before connecting.',
      );
    } catch (e) {
      setError(asError(e).message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal title="Import from IntelliJ" wide dismissible={!busy} onClose={onClose}>
      <div className="modal-body intellij-import">
        <p className="muted">
          Preview an exported settings ZIP, a keymap, run configuration or data-source XML file, an
          IntelliJ configuration folder, or a project’s .idea folder. The source stays unchanged.
        </p>
        <div className="import-source">
          <label className="field-label">
            Settings source
            <input
              data-autofocus
              value={path}
              disabled={busy}
              placeholder="Absolute path to a settings file or folder"
              onChange={(event) => {
                setPath(event.target.value);
                invalidate();
              }}
            />
          </label>
          <div className="import-buttons">
            <button type="button" disabled={busy} onClick={() => void choose(false)}>
              Choose XML or ZIP…
            </button>
            <button type="button" disabled={busy} onClick={() => void choose(true)}>
              Choose folder…
            </button>
          </div>
          <details>
            <summary>Where to find your IntelliJ settings</summary>
            <p className="muted">
              In IntelliJ, use File → Manage IDE Settings → Export Settings for a ZIP. On macOS,
              configuration folders are under ~/Library/Application Support/JetBrains/. Custom
              keymaps are in the keymaps subfolder. Project database connections are in
              .idea/dataSources.xml; an exported settings ZIP may only include global connections.
              Project run configurations are in .idea/runConfigurations/, .run/, or
              .idea/workspace.xml.
            </p>
          </details>
          <details>
            <summary>Project directory for relative paths</summary>
            <p className="muted">
              Used to resolve IntelliJ’s $PROJECT_DIR$ paths. Check this if importing settings from
              another project.
            </p>
            <label className="field-label">
              Original project directory (optional)
              <div className="input-with-button">
                <input
                  value={projectRoot}
                  disabled={busy}
                  onChange={(event) => {
                    setProjectRoot(event.target.value);
                    invalidate();
                  }}
                />
                <button type="button" disabled={busy} onClick={() => void choose(true, true)}>
                  Browse project…
                </button>
              </div>
            </label>
          </details>
          <button
            type="button"
            className="primary"
            disabled={busy || !path.trim()}
            onClick={() => void inspect()}
          >
            {busy && !preview ? 'Reading settings…' : 'Preview import'}
          </button>
        </div>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        {message && (
          <p className="inline-notice" role="status">
            {message}
          </p>
        )}
        {preview && (
          <div className="import-review">
            <h3>Review {preview.source}</h3>
            <p className="muted">
              Keybindings are added to your Settings draft. Connections, run configurations and
              appearance have their own apply buttons below.
            </p>
            {preview.notices.length > 0 && (
              <NoticeList title="Source notes" notices={preview.notices} />
            )}
            {!runOnly && keymapNames.length > 0 && (
              <section aria-label="Keymap import" className="import-section">
                <h3>Keybindings</h3>
                <label className="field-label">
                  IntelliJ keymap
                  <select
                    value={keymap}
                    disabled={busy}
                    onChange={(event) => setKeymap(event.target.value)}
                  >
                    {keymapNames.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                {mapping && (
                  <>
                    <p className="muted">
                      {mapping.changes.length} changed binding
                      {mapping.changes.length === 1 ? '' : 's'}. Only commands supported by Zwip can
                      be imported.
                      {!mapping.complete && ' This is a partial mapping; review the notes below.'}
                    </p>
                    <div className="import-table-scroll">
                      <table className="import-keymap-table">
                        <thead>
                          <tr>
                            <th scope="col">Action</th>
                            <th scope="col">Current</th>
                            <th scope="col">Import</th>
                          </tr>
                        </thead>
                        <tbody>
                          {mapping.changes.map((change) => (
                            <tr key={change.action}>
                              <td>{shortcutActions[change.action]}</td>
                              <td>
                                <kbd>{change.from ? shortcutLabel(change.from) : 'Unassigned'}</kbd>
                              </td>
                              <td>
                                <kbd>{change.to ? shortcutLabel(change.to) : 'Unassigned'}</kbd>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {mapping.notices.length > 0 && (
                      <NoticeList title="Keymap notes" notices={mapping.notices} />
                    )}
                    {mapping.conflicts.length > 0 && (
                      <div className="import-warning" role="note">
                        <strong>Conflicting shortcuts</strong>
                        <ul>
                          {mapping.conflicts.map((conflict) => (
                            <li key={conflict}>{conflict}</li>
                          ))}
                        </ul>
                        <p>Resolve these in Settings before saving.</p>
                      </div>
                    )}
                    <button
                      type="button"
                      disabled={busy || !mapping.changes.length}
                      onClick={() => {
                        onKeymap?.(mapping.shortcuts);
                        onClose();
                      }}
                    >
                      Use reviewed keybindings
                    </button>
                  </>
                )}
              </section>
            )}
            {!runOnly && preview.connections.length > 0 && (
              <section aria-label="Database connection import" className="import-section">
                <h3>Database connections</h3>
                <p className="muted">
                  Import saves connection details without connecting. Existing entries are kept.
                  Passwords and IntelliJ’s password store are not imported.
                </p>
                <div className="import-connection-list">
                  {preview.connections.map((item) => (
                    <div key={item.id} className="import-connection">
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          disabled={busy || item.status !== 'ready'}
                          checked={selected.has(item.id)}
                          onChange={(event) =>
                            setSelected((current) => {
                              const next = new Set(current);
                              if (event.target.checked) next.add(item.id);
                              else next.delete(item.id);
                              return next;
                            })
                          }
                        />
                        <strong>{item.name}</strong>
                        <span className="muted">
                          {item.status === 'ready'
                            ? item.connection?.kind
                            : item.status === 'duplicate'
                              ? 'Already saved'
                              : 'Needs manual setup'}
                        </span>
                      </label>
                      {item.connection && (
                        <p className="import-connection-target">
                          {item.connection.kind === 'sqlite'
                            ? item.connection.config.path
                            : (item.connection.config.host ?? '') +
                              ':' +
                              (item.connection.config.port ?? '') +
                              '/' +
                              (item.connection.config.database ?? '')}
                          {item.connection.config.username &&
                            ' · ' + item.connection.config.username}
                          {item.connection.kind !== 'sqlite' &&
                            (item.connection.config.tls ? ' · TLS' : ' · No TLS')}
                        </p>
                      )}
                      {item.notes.length > 0 && (
                        <ul className="muted">
                          {item.notes.map((note, i) => (
                            <li key={i}>{note}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  className="primary"
                  disabled={busy || !selected.size}
                  onClick={() => void importConnections()}
                >
                  {busy
                    ? 'Importing…'
                    : 'Import ' +
                      selected.size +
                      ' selected connection' +
                      (selected.size === 1 ? '' : 's')}
                </button>
              </section>
            )}
            {preview.runConfigurations?.length > 0 &&
              (runSession ? (
                <IntelliJRunImport
                  key={preview.fingerprint}
                  preview={preview}
                  path={path.trim()}
                  projectRoot={projectRoot.trim()}
                  session={runSession}
                  busy={busy}
                  onBusy={(value) => {
                    busyRef.current = value;
                    setBusy(value);
                  }}
                  onMessage={setMessage}
                  onError={setError}
                />
              ) : (
                <p>
                  Open a workspace to review and import the {preview.runConfigurations.length}{' '}
                  run/debug configurations found in this source.
                </p>
              ))}
            {!runOnly && preview.appearance && (
              <section aria-label="Appearance import" className="import-section">
                <h3>Appearance</h3>
                <p className="muted">
                  {preview.appearance.name} maps to Zwip’s{' '}
                  {preview.appearance.dark ? 'dark' : 'light'} theme. Custom colors and editor fonts
                  are not imported.
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    onAppearance?.(preview.appearance!.dark);
                    setMessage(
                      'Applied ' + (preview.appearance!.dark ? 'dark' : 'light') + ' appearance.',
                    );
                  }}
                >
                  Apply appearance
                </button>
              </section>
            )}
            {(runOnly || !keymapNames.length) &&
              (runOnly || !preview.connections.length) &&
              !preview.runConfigurations?.length &&
              (runOnly || !preview.appearance) && (
                <p>No supported settings were found in this source.</p>
              )}
          </div>
        )}
      </div>
      <div className="modal-actions">
        <button type="button" disabled={busy} onClick={onClose}>
          {runOnly ? 'Close' : 'Back to Settings'}
        </button>
      </div>
    </Modal>
  );
}

function NoticeList({ title, notices }: { title: string; notices: string[] }) {
  return (
    <details className="import-notices" open>
      <summary>
        {title} ({notices.length})
      </summary>
      <ul>
        {notices.map((notice, index) => (
          <li key={index}>{notice}</li>
        ))}
      </ul>
    </details>
  );
}
