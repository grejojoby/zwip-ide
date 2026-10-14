import { useEffect, useRef, useState } from 'react';
import {
  formatEnvironment,
  parseEnvironment,
  type EnvironmentVariable,
  type RunConfiguration,
  type RunState,
  type WorkspaceRunSession,
} from '../model/run-configurations';
import { Icon } from './Icon';

const importOption = '__import-from-intellij__';

export function TaskPanel({
  session,
  state,
  onImport,
}: {
  session: WorkspaceRunSession;
  state: RunState;
  onImport?(): void;
}) {
  const selected = state.settings.configurations.find(
    (config) => config.id === state.settings.selectedId,
  );
  const output = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (output.current) output.current.scrollTop = output.current.scrollHeight;
  }, [state.task?.output]);
  return (
    <section className="task-panel" aria-label="Run task">
      <div className="run-configuration-toolbar">
        <label>
          Configuration
          <select
            aria-label="Edit run configuration"
            value={state.settings.selectedId ?? ''}
            disabled={!state.ready || state.saving}
            onChange={(event) => {
              if (event.target.value === importOption) onImport?.();
              else void session.select(event.target.value || null);
            }}
          >
            <option value="">Ad hoc command / new configuration</option>
            {state.settings.configurations.map((config) => (
              <option key={config.id} value={config.id}>
                {config.name}
              </option>
            ))}
            {onImport && <option value={importOption}>Import from IntelliJ…</option>}
          </select>
        </label>
        <button
          type="button"
          disabled={!state.ready || state.saving}
          onClick={() => void session.select(null)}
        >
          New
        </button>
        <button
          type="button"
          disabled={!selected || state.saving}
          onClick={() => selected && void session.remove(selected.id)}
        >
          Remove configuration
        </button>
      </div>
      <ConfigurationForm
        key={`${session.root}:${selected?.id ?? 'adhoc'}`}
        selected={selected}
        session={session}
        state={state}
      />
      {state.error && (
        <p className="error-message inline-notice" role="alert">
          {state.error}
        </p>
      )}
      <div className="task-command">
        <span>
          {state.taskLabel || 'Output'}{' '}
          {state.task &&
            (state.task.running ? '· Running' : `· Exited ${state.task.exitCode ?? '—'}`)}
        </span>
        <button type="button" disabled={!state.task?.running} onClick={() => void session.stop()}>
          <Icon name="stop" />
          Stop
        </button>
      </div>
      <pre ref={output} className="task-output" aria-label="Task output">
        {state.task && state.taskCommand ? (
          <>
            <span className="task-command-line">
              {state.taskCommand.cwd} $ {state.taskCommand.command}
              {'\n'}
            </span>
            {state.task.output}
            <TaskProgress task={state.task} startedAt={state.taskCommand.startedAt} />
          </>
        ) : (
          state.task?.output || 'Command output appears here.'
        )}
      </pre>
    </section>
  );
}

/** Elapsed time while running, then the exit line, so silent builds or servers never look stuck. */
function TaskProgress({
  task,
  startedAt,
}: {
  task: NonNullable<RunState['task']>;
  startedAt: number;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!task.running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [task.running]);
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  const separator = task.output && !task.output.endsWith('\n') ? '\n' : '';
  return (
    <span className="task-progress">
      {separator}
      {task.running
        ? `Running for ${seconds}s${task.output ? '' : ' · no output yet (builds and quiet servers print nothing)'}`
        : `Process finished with exit code ${task.exitCode ?? '—'}`}
    </span>
  );
}

function ConfigurationForm({
  selected,
  session,
  state,
}: {
  selected?: RunConfiguration;
  session: WorkspaceRunSession;
  state: RunState;
}) {
  const [name, setName] = useState(selected?.name ?? '');
  const [command, setCommand] = useState(selected?.command ?? '');
  const [directory, setDirectory] = useState(selected?.workingDirectory ?? '.');
  const [envText, setEnvText] = useState(formatEnvironment(selected?.env));
  let env: EnvironmentVariable[] = [];
  let envError = '';
  try {
    env = parseEnvironment(envText);
  } catch (error) {
    envError = error instanceof Error ? error.message : String(error);
  }
  const changedTarget =
    !!selected && (selected.command !== command || selected.workingDirectory !== directory);
  const dirty =
    !!selected &&
    (selected.name !== name ||
      selected.command !== command ||
      selected.workingDirectory !== directory ||
      formatEnvironment(selected.env) !== formatEnvironment(env));
  return (
    <form
      className="run-configuration-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!envError) void session.run(command, directory, name.trim() || 'Ad hoc command', env);
      }}
    >
      <div className="run-configuration-fields">
        <label>
          Name
          <input
            aria-label="Run configuration name"
            placeholder="Optional for an ad hoc command"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          Working directory
          <input
            aria-label="Run working directory"
            placeholder="Relative to workspace (.)"
            value={directory}
            onChange={(event) => setDirectory(event.target.value)}
          />
        </label>
        <label className="run-environment">
          Environment
          <textarea
            aria-label="Run environment variables"
            placeholder="NAME=value, one per line"
            rows={Math.min(6, Math.max(2, envText.split('\n').length))}
            spellCheck={false}
            value={envText}
            onChange={(event) => setEnvText(event.target.value)}
          />
        </label>
      </div>
      {envError && (
        <p className="error-message inline-notice" role="alert">
          {envError}
        </p>
      )}
      <div className="task-command">
        <Icon name="terminal" />
        <input
          aria-label="Command to run"
          placeholder="Run a workspace command…"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
        />
        <button
          type="submit"
          disabled={
            !state.ready ||
            state.saving ||
            state.starting ||
            state.task?.running ||
            !command.trim() ||
            !!envError
          }
        >
          <Icon name="play" />
          Run
        </button>
        <button
          type="button"
          disabled={!state.ready || state.saving || !command.trim() || !name.trim() || !!envError}
          onClick={() =>
            void session.save({
              id: selected?.id ?? crypto.randomUUID(),
              name,
              command,
              workingDirectory: directory,
              ...(env.length && { env }),
              ...(!changedTarget && selected?.debug && { debug: selected.debug }),
            })
          }
        >
          Save configuration
        </button>
        {dirty && <span>Unsaved changes</span>}
      </div>
      {selected?.debug && changedTarget && (
        <p className="inline-notice" role="status">
          Saving these changes removes the imported Go debug target. Re-import the configuration to
          restore it.
        </p>
      )}
    </form>
  );
}
