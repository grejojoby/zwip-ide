import { useEffect, useRef, useState } from 'react';
import type { BuildContext, Position } from '../../contracts';
import { collectGoEvents, updateGoTests } from '../../model/go-results';
import { asError } from '../../model/document-session';
import { goTool } from './go-api';
import { GoDebugger } from './GoDebugger';
import type { CoverageReport, GoJob, GoTestEvent } from '../../model/go-types';
export function GoTools({
  contexts,
  path,
  breakpoints,
  onCoverage,
  onOpen,
  onExecution,
  onClose,
  beforeStart,
  configuredTarget,
}: {
  contexts: BuildContext[];
  path?: string;
  breakpoints: Record<string, number[]>;
  onCoverage(coverage: CoverageReport): void;
  onOpen(path: string, position: Position): void;
  onExecution(location: { path: string; line: number } | null): void;
  onClose(): void;
  beforeStart(): Promise<void>;
  configuredTarget?: {
    path: string;
    workingDirectory: string;
    args: string[];
    env?: { name: string; value: string }[];
    mode: 'debug' | 'test';
  };
}) {
  const [contextId, setContextId] = useState('');
  const [scope, setScope] = useState<'file' | 'module'>('file');
  const [pattern, setPattern] = useState('');
  const [args, setArgs] = useState('[]');
  const [coverage, setCoverage] = useState(true);
  const [job, setJob] = useState<GoJob | null>(null);
  const [tests, setTests] = useState<Map<string, GoTestEvent>>(new Map());
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'tests' | 'output' | 'coverage' | 'debug'>('tests');
  const [debugMode, setDebugMode] = useState<'debug' | 'test' | null>(null);
  const activeJob = useRef<string | null>(null);
  const epoch = useRef(0);
  const starting = useRef(false);
  const prepared = useRef(configuredTarget);
  const currentContexts = useRef(contexts);
  prepared.current = configuredTarget;
  currentContexts.current = contexts;
  const goContexts = contexts.filter((context) => context.language === 'go');
  const selected =
    goContexts.find((context) => context.id === contextId) ??
    goContexts
      .filter((context) => path?.startsWith(`${context.root}/`))
      .sort((a, b) => b.root.length - a.root.length)[0] ??
    goContexts[0];
  const targetPath = scope === 'file' && path?.endsWith('.go') ? path : selected?.root;
  const callback = useRef(onCoverage);
  callback.current = onCoverage;
  const [debugTarget, setDebugTarget] = useState<{
    contextId: string;
    path: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
  } | null>(null);
  useEffect(() => {
    const life = ++epoch.current;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const id = activeJob.current;
        if (id) {
          const result = await goTool('job.poll', { jobId: id, after: cursor.current });
          if (epoch.current === life && activeJob.current === id && result.job) adopt(result.job);
        }
      } catch (e) {
        if (epoch.current === life) {
          setError(asError(e).message);
          activeJob.current = null;
        }
      } finally {
        if (epoch.current === life)
          timer = setTimeout(() => void poll(), activeJob.current ? 300 : 1000);
      }
    }
    timer = setTimeout(() => void poll(), 300);
    return () => {
      ++epoch.current;
      clearTimeout(timer);
      if (activeJob.current)
        void goTool('job.cancel', { jobId: activeJob.current }).catch(() => {});
    };
  }, []);
  const cursor = useRef(0);
  function adopt(next: GoJob) {
    const collected = collectGoEvents(next, cursor.current);
    cursor.current = collected.cursor;
    setJob(next);
    setTests((current) => updateGoTests(current, collected.tests));
    if (collected.output) setOutput((current) => (current + collected.output).slice(-1000000));
    if (next.status !== 'running') {
      activeJob.current = null;
      if (next.coverage) callback.current(next.coverage);
    }
  }
  function programArgs() {
    const values: unknown = JSON.parse(args);
    if (!Array.isArray(values) || values.some((value) => typeof value !== 'string'))
      throw new Error('Program arguments must be a JSON array of strings.');
    return values as string[];
  }
  async function start(kind: 'run' | 'test') {
    if (!selected || !targetPath || starting.current || activeJob.current || debugMode) return;
    starting.current = true;
    setBusy(true);
    setError('');
    setTests(new Map());
    setOutput('');
    setJob(null);
    setTab(kind === 'run' ? 'output' : 'tests');
    cursor.current = 0;
    const life = epoch.current;
    try {
      await beforeStart();
      if (epoch.current !== life) return;
      const parameters = {
        contextId: selected.id,
        ...(scope === 'file' ? { path: targetPath } : { package: kind === 'test' ? './...' : '.' }),
        programArgs: programArgs(),
        ...(kind === 'test' ? { coverage, testPattern: pattern } : {}),
      };
      const result = await goTool(`${kind}.start`, parameters);
      if (epoch.current !== life) {
        if (result.job) void goTool('job.cancel', { jobId: result.job.id });
        return;
      }
      if (result.job) {
        activeJob.current = result.job.id;
        adopt(result.job);
      }
    } catch (e) {
      if (epoch.current === life) setError(asError(e).message);
    } finally {
      if (epoch.current === life) {
        starting.current = false;
        setBusy(false);
      }
    }
  }
  async function debug(mode: 'debug' | 'test') {
    if (!selected || !targetPath || starting.current || activeJob.current || debugMode) return;
    starting.current = true;
    setBusy(true);
    setError('');
    const life = epoch.current;
    try {
      await beforeStart();
      if (epoch.current !== life) return;
      setDebugTarget({
        contextId: selected.id,
        path: targetPath.endsWith('.go')
          ? targetPath.slice(0, targetPath.lastIndexOf('/'))
          : targetPath,
        args: mode === 'test' && pattern ? ['-test.run', pattern, ...programArgs()] : programArgs(),
      });
      setDebugMode(mode);
      setTab('debug');
    } catch (e) {
      if (epoch.current === life) setError(asError(e).message);
    } finally {
      if (epoch.current === life) {
        starting.current = false;
        setBusy(false);
      }
    }
  }
  async function debugPrepared() {
    const target = prepared.current;
    if (!target || starting.current || activeJob.current || debugMode) return;
    starting.current = true;
    setBusy(true);
    setError('');
    const life = epoch.current;
    try {
      const eligible = () =>
        currentContexts.current
          .filter(
            (context) =>
              context.language === 'go' &&
              !context.profileId &&
              (target.path === context.root || target.path.startsWith(`${context.root}/`)),
          )
          .sort((a, b) => b.root.length - a.root.length)[0];
      if (!eligible())
        throw new Error(
          'The Go package has no default build context for this target. Install and enable Go support, then refresh the workspace.',
        );
      await beforeStart();
      if (epoch.current !== life) return;
      if (prepared.current !== target)
        throw new Error('The prepared configuration changed. Review it and click Debug again.');
      const context = eligible();
      if (!context)
        throw new Error(
          'The Go package has no default build context for this target. Refresh the workspace.',
        );
      if (
        target.workingDirectory !== context.root &&
        !target.workingDirectory.startsWith(`${context.root}/`)
      )
        throw new Error('The debug working directory must be inside the selected Go module.');
      setDebugTarget({
        contextId: context.id,
        path: target.path,
        cwd: target.workingDirectory,
        args: [...target.args],
        ...(target.env?.length && {
          env: Object.fromEntries(target.env.map(({ name, value }) => [name, value])),
        }),
      });
      setDebugMode(target.mode);
      setTab('debug');
    } catch (e) {
      if (epoch.current === life) setError(asError(e).message);
    } finally {
      if (epoch.current === life) {
        starting.current = false;
        setBusy(false);
      }
    }
  }
  const locked = busy || !!activeJob.current || !!debugMode;
  return (
    <section className="go-tools" aria-label="Go tools">
      {configuredTarget && (
        <div className="inline-notice">
          <span>
            Prepared Go {configuredTarget.mode === 'test' ? 'test' : 'debug'} target:{' '}
            {configuredTarget.path} · working directory: {configuredTarget.workingDirectory} ·
            arguments: {JSON.stringify(configuredTarget.args)}
            {configuredTarget.env?.length
              ? ` · environment: ${configuredTarget.env.map(({ name }) => name).join(', ')}`
              : ''}
          </span>{' '}
          <button disabled={locked} onClick={() => void debugPrepared()}>
            Debug prepared configuration
          </button>
        </div>
      )}
      <div className="go-run-toolbar">
        <select
          aria-label="Go module and build profile"
          value={selected?.id ?? ''}
          disabled={locked}
          onChange={(e) => setContextId(e.target.value)}
        >
          {goContexts.map((context) => (
            <option key={context.id} value={context.id}>
              {context.root.split('/').pop()}
              {context.profileId ? ` · ${context.profileId}` : ' · default'}
            </option>
          ))}
        </select>
        <select
          aria-label="Go execution scope"
          value={scope}
          disabled={locked}
          onChange={(e) => setScope(e.target.value as 'file' | 'module')}
        >
          <option value="file">Current file’s package</option>
          <option value="module">Selected module</option>
        </select>
        <input
          aria-label="Go test pattern"
          placeholder="Test / subtest pattern"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
        />
        <label>
          <input
            type="checkbox"
            checked={coverage}
            onChange={(e) => setCoverage(e.target.checked)}
          />
          Coverage
        </label>
        <button disabled={locked || !selected} onClick={() => void start('test')}>
          Test
        </button>
        <button disabled={locked || !selected} onClick={() => void start('run')}>
          Run
        </button>
        <button disabled={locked || !selected} onClick={() => void debug('debug')}>
          Debug
        </button>
        <button disabled={locked || !selected} onClick={() => void debug('test')}>
          Debug tests
        </button>
        <button
          disabled={!activeJob.current}
          onClick={() => {
            const id = activeJob.current;
            if (id)
              void goTool('job.cancel', { jobId: id })
                .then((result) => {
                  if (result.job) adopt(result.job);
                })
                .catch((e) => setError(asError(e).message));
          }}
        >
          Stop
        </button>
        <button onClick={onClose}>Close tools</button>
      </div>
      <details className="go-run-options">
        <summary>Program arguments · saved source only</summary>
        <input
          aria-label="Go program arguments"
          value={args}
          onChange={(e) => setArgs(e.target.value)}
          placeholder='["argument"]'
        />
      </details>
      {error && (
        <p role="alert" className="inline-notice error-message">
          {error}
        </p>
      )}
      <div className="response-tabs">
        {(['tests', 'output', 'coverage', 'debug'] as const).map((item) => (
          <button key={item} aria-pressed={tab === item} onClick={() => setTab(item)}>
            {item[0].toUpperCase() + item.slice(1)}
          </button>
        ))}
        <span>
          {job?.status}
          {job?.droppedBefore ? ' · earlier events were dropped' : ''}
        </span>
      </div>
      <div className="go-results">
        {tab === 'tests' && (
          <div className="go-tests">
            {[...tests].map(([key, test]) => (
              <div
                key={key}
                className={`test-${test.Action}`}
                style={{ paddingLeft: 12 + ((test.Test ?? '').split('/').length - 1) * 12 }}
              >
                <span>
                  {test.Action === 'pass'
                    ? '✓'
                    : test.Action === 'fail'
                      ? '×'
                      : test.Action === 'skip'
                        ? '−'
                        : '·'}
                </span>
                <strong>{test.Test}</strong>
                <small>{test.Package}</small>
                <time>{test.Elapsed === undefined ? '' : `${test.Elapsed}s`}</time>
              </div>
            ))}
            {!tests.size && (
              <p className="empty-note">
                {job?.status === 'running'
                  ? 'Waiting for test events…'
                  : 'Choose a package or module to run tests.'}
              </p>
            )}
          </div>
        )}
        {tab === 'output' && <pre className="task-output">{output || 'No output yet.'}</pre>}
        {tab === 'coverage' &&
          (job?.coverage ? (
            <div className="go-coverage">
              <strong>{job.coverage.percent.toFixed(1)}% statement coverage</strong>
              {job.coverage.files.map((file) => (
                <button
                  key={file.path}
                  onClick={() => onOpen(file.path, { line: 0, character: 0 })}
                >
                  <span>{file.path}</span>
                  <strong>{file.percent.toFixed(1)}%</strong>
                  <small>
                    {file.coveredStatements}/{file.totalStatements}
                  </small>
                </button>
              ))}
            </div>
          ) : (
            <p className="empty-note">
              Enable coverage and complete a test run to show covered and uncovered lines.
            </p>
          ))}
        {debugMode && debugTarget && (
          <div
            style={{
              display: tab === 'debug' ? 'flex' : 'none',
              height: '100%',
              flexDirection: 'column',
            }}
          >
            <GoDebugger
              target={debugTarget}
              mode={debugMode}
              breakpoints={breakpoints}
              onOpen={onOpen}
              onExecution={onExecution}
              onStopped={() => setDebugMode(null)}
            />
          </div>
        )}
        {tab === 'debug' && !debugMode && (
          <p className="empty-note">
            Set breakpoints in the editor gutter or with F9, then start debugging.
          </p>
        )}
      </div>
    </section>
  );
}
