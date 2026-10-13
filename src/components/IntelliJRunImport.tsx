import { useEffect, useState, useSyncExternalStore } from 'react';
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
  // `${configuration id}:${variable}` for credential-like values the user chose to import.
  const [revealed, setRevealed] = useState(new Set<string>());
  // Enabled packages can make more configuration types importable (Makefile targets).
  const [makeEnabled, setMakeEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = () =>
      api
        .packages()
        .then((packages) => {
          if (active) setMakeEnabled(packages.some((item) => item.id === 'make' && item.enabled));
        })
        .catch(() => undefined);
    void refresh();
    window.addEventListener('zwip:packages-changed', refresh);
    return () => {
      active = false;
      window.removeEventListener('zwip:packages-changed', refresh);
    };
  }, []);
  const candidates = previewIntelliJRunConfigurations(
    preview.runConfigurations,
    projectRoot,
    session.root,
    state.settings.configurations,
    { make: makeEnabled },
  );
  const chosen = candidates.filter((item) => selected.has(item.id) && item.status === 'ready');
  async function apply() {
    if (busy || !chosen.length || !state.ready || state.saving) return;
    onBusy(true);
    onMessage('');
    onError('');
    try {
      const reveal = chosen.some((item) =>
        item.sensitive.some((name) => revealed.has(`${item.id}:${name}`)),
      );
      const fresh = await api.previewIntelliJ(path, projectRoot || undefined, reveal);
      if (fresh.fingerprint !== preview.fingerprint)
        throw new Error('The IntelliJ source changed. Preview it again before importing.');
      const configurations = chosen.map((item) => {
        const configuration = item.configuration!;
        if (!item.sensitive.length) return configuration;
        const source = fresh.runConfigurations.find((row) => row.id === item.id)?.fields.env;
        return {
          ...configuration,
          env: configuration.env?.map((variable) =>
            revealed.has(`${item.id}:${variable.name}`)
              ? {
                  ...variable,
                  value: source?.find((row) => row.name === variable.name)?.value ?? '',
                }
              : variable,
          ),
        };
      });
      if (!(await session.importConfigurations(configurations)))
        throw new Error(session.getSnapshot().error || 'Run configurations could not be saved.');
      setSelected(new Set());
      setRevealed(new Set());
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
            {item.configuration && (
              <RunPreview
                configuration={item.configuration}
                sensitive={item.sensitive}
                revealed={(name) => revealed.has(`${item.id}:${name}`)}
                disabled={busy}
                onReveal={(name, include) =>
                  setRevealed((current) => {
                    const next = new Set(current);
                    if (include) next.add(`${item.id}:${name}`);
                    else next.delete(`${item.id}:${name}`);
                    return next;
                  })
                }
              />
            )}
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

function RunPreview({
  configuration,
  sensitive,
  revealed,
  disabled,
  onReveal,
}: {
  configuration: RunConfiguration;
  sensitive: string[];
  revealed(name: string): boolean;
  disabled: boolean;
  onReveal(name: string, include: boolean): void;
}) {
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
      {!!configuration.env?.length && (
        <div className="import-run-env">
          <p>Environment</p>
          {configuration.env.map(({ name, value }) =>
            sensitive.includes(name) ? (
              <label key={name} className="checkbox-label">
                <input
                  type="checkbox"
                  aria-label={`Import value of ${name}`}
                  checked={revealed(name)}
                  disabled={disabled}
                  onChange={(event) => onReveal(name, event.target.checked)}
                />
                <code>{name}=••••••</code>
                <span className="muted">
                  {revealed(name)
                    ? 'Value will be imported'
                    : 'Looks like a credential · imported empty unless checked'}
                </span>
              </label>
            ) : (
              <code key={name}>
                {name}={value}
              </code>
            ),
          )}
        </div>
      )}
    </div>
  );
}
