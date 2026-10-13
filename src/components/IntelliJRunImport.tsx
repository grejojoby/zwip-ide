import { useState, useSyncExternalStore } from 'react';
import { api } from '../api';
import { asError } from '../model/document-session';
import type { IntelliJImportPreview } from '../model/intellij-import-contracts';
import { previewIntelliJRunConfigurations } from '../model/intellij-run-configurations';
import type { RunConfiguration, WorkspaceRunSession } from '../model/run-configurations';

export function IntelliJRunImport({
  preview,
  path,
  projectRoot,
  session,
  busy,
  onBusy,
  onMessage,
  onError,
}: {
  preview: IntelliJImportPreview;
  path: string;
  projectRoot: string;
  session: WorkspaceRunSession;
  busy: boolean;
  onBusy(busy: boolean): void;
  onMessage(message: string): void;
  onError(message: string): void;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [selected, setSelected] = useState(new Set<string>());
  const candidates = previewIntelliJRunConfigurations(
    preview.runConfigurations,
    projectRoot,
    session.root,
    state.settings.configurations,
  );
  const chosen = candidates.filter((item) => selected.has(item.id) && item.status === 'ready');
  async function apply() {
    if (busy || !chosen.length || !state.ready || state.saving) return;
    onBusy(true);
    onMessage('');
    onError('');
    try {
      const fresh = await api.previewIntelliJ(path, projectRoot || undefined);
      if (fresh.fingerprint !== preview.fingerprint)
        throw new Error('The IntelliJ source changed. Preview it again before importing.');
      const configurations = chosen.map((item) => item.configuration!);
      if (!(await session.importConfigurations(configurations)))
        throw new Error(session.getSnapshot().error || 'Run configurations could not be saved.');
      setSelected(new Set());
      onMessage(
        `${configurations.length} run configuration${configurations.length === 1 ? '' : 's'} saved. Choose one in the toolbar when you want to run it. Nothing was launched.`,
      );
    } catch (error) {
      onError(asError(error).message);
    } finally {
      onBusy(false);
    }
  }
  return (
    <section aria-label="Run and debug configuration import" className="import-section">
      <h3>Run/debug configurations</h3>
      <p className="muted">
        Review the exact commands and select the configurations to save to this workspace. Importing
        does not run commands. Existing configurations and your current selection are kept. Go debug
        targets open in Go tools; browser debugging uses external DevTools.
      </p>
      <p className="import-connection-target">Destination: {session.root}</p>
      {!state.ready && (
        <p className="error-message">{state.error || 'Loading workspace configurations…'}</p>
      )}
      <div className="import-connection-list">
        {candidates.map((item) => (
          <div key={item.id} className="import-connection">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={selected.has(item.id) && item.status === 'ready'}
                disabled={busy || !state.ready || state.saving || item.status !== 'ready'}
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
                  ? item.type
                  : item.status === 'duplicate'
                    ? 'Already saved'
                    : 'Needs manual setup'}
              </span>
            </label>
            {item.configuration && <RunPreview configuration={item.configuration} />}
            {!!item.notes.length && (
              <ul className="muted">
                {item.notes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
      <button
        type="button"
        className="primary"
        disabled={busy || !state.ready || state.saving || !chosen.length}
        onClick={() => void apply()}
      >
        Import {chosen.length} selected run configuration{chosen.length === 1 ? '' : 's'}
      </button>
    </section>
  );
}

function RunPreview({ configuration }: { configuration: RunConfiguration }) {
  return (
    <div className="import-run-preview">
      <p>
        Working directory: <code>{configuration.workingDirectory}</code>
      </p>
      <pre>{configuration.command}</pre>
      {configuration.debug && (
        <p>
          Go {configuration.debug.mode === 'test' ? 'test debugger' : 'debugger'}:{' '}
          <code>{configuration.debug.path}</code> · Arguments:{' '}
          <code>{JSON.stringify(configuration.debug.args)}</code>
        </p>
      )}
    </div>
  );
}
