import { useEffect, useRef, useState } from 'react';
import type { Position } from '../../contracts';
import { asError } from '../../model/document-session';
import { goTool } from './go-api';
import type { DebugEvent, DebugFrame, DebugVariable } from '../../model/go-types';
interface Scope {
  name: string;
  variablesReference: number;
  expensive?: boolean;
}
export function GoDebugger({
  target,
  mode,
  breakpoints,
  onOpen,
  onExecution,
  onStopped,
}: {
  target: {
    contextId: string;
    path: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
  };
  mode: 'debug' | 'test';
  breakpoints: Record<string, number[]>;
  onOpen(path: string, position: Position): void;
  onExecution(location: { path: string; line: number } | null): void;
  onStopped(): void;
}) {
  const [status, setStatus] = useState('Starting debugger…');
  const [error, setError] = useState('');
  const [output, setOutput] = useState('');
  const [paused, setPaused] = useState(false);
  const [threads, setThreads] = useState<{ id: number; name: string }[]>([]);
  const [threadId, setThreadId] = useState<number>();
  const [frames, setFrames] = useState<DebugFrame[]>([]);
  const [frameId, setFrameId] = useState<number>();
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [watches, setWatches] = useState<string[]>([]);
  const [watchInput, setWatchInput] = useState('');
  const [watchValues, setWatchValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [breakpointMessage, setBreakpointMessage] = useState('');
  const epoch = useRef(0);
  const session = useRef<string | null>(null);
  const callbacks = useRef({ onOpen, onExecution, onStopped });
  callbacks.current = { onOpen, onExecution, onStopped };
  const breakpointRef = useRef(breakpoints);
  breakpointRef.current = breakpoints;
  const watchRef = useRef(watches);
  watchRef.current = watches;
  const configured = useRef(false);
  const sentPaths = useRef(new Set<string>());
  const sourceQueue = useRef<Promise<void>>(Promise.resolve());
  const frameRequest = useRef(0);
  const threadRequest = useRef(0);
  const watchRequest = useRef(0);
  async function dap<T>(
    command: string,
    args: Record<string, unknown> = {},
    id = session.current,
  ): Promise<T> {
    if (!id) throw new Error('Debugger is not connected.');
    const result = await goTool('debug.request', { sessionId: id, command, arguments: args });
    if (!result.response?.success)
      throw new Error(result.response?.message ?? 'Debugger request failed.');
    return result.response.body as T;
  }
  async function setSources(id: string) {
    const current = breakpointRef.current;
    const paths = new Set([...sentPaths.current, ...Object.keys(current)]);
    const warnings: string[] = [];
    for (const path of paths) {
      if (!path.endsWith('.go')) continue;
      try {
        const response = await dap<{
          breakpoints: { verified: boolean; line?: number; message?: string }[];
        }>(
          'setBreakpoints',
          {
            source: { path },
            breakpoints: (current[path] ?? []).map((line) => ({ line: line + 1 })),
            sourceModified: false,
          },
          id,
        );
        response.breakpoints?.forEach((item) => {
          if (!item.verified)
            warnings.push(
              `${path.split('/').pop()}:${item.line ?? '?'} ${item.message ?? 'unverified'}`,
            );
        });
      } catch (e) {
        warnings.push(`${path.split('/').pop()}: ${asError(e).message}`);
      }
    }
    sentPaths.current = new Set(Object.keys(current));
    setBreakpointMessage(warnings.join(' · '));
  }
  function syncBreakpoints(id: string) {
    const next = sourceQueue.current.catch(() => {}).then(() => setSources(id));
    sourceQueue.current = next;
    return next;
  }
  async function selectFrame(frame: DebugFrame) {
    const request = ++frameRequest.current;
    ++watchRequest.current;
    setFrameId(frame.id);
    setScopes([]);
    if (frame.source?.path) {
      callbacks.current.onExecution({ path: frame.source.path, line: Math.max(0, frame.line - 1) });
      callbacks.current.onOpen(frame.source.path, {
        line: Math.max(0, frame.line - 1),
        character: Math.max(0, frame.column - 1),
      });
    }
    try {
      const response = await dap<{ scopes: Scope[] }>('scopes', { frameId: frame.id });
      if (request !== frameRequest.current) return;
      setScopes(response.scopes);
      await evaluateWatches(frame.id);
    } catch (e) {
      if (request === frameRequest.current) setError(asError(e).message);
    }
  }
  async function selectThread(id: number) {
    const request = ++threadRequest.current;
    ++frameRequest.current;
    ++watchRequest.current;
    setThreadId(id);
    setFrames([]);
    setScopes([]);
    try {
      const result = await dap<{ stackFrames: DebugFrame[] }>('stackTrace', {
        threadId: id,
        startFrame: 0,
        levels: 100,
      });
      if (request !== threadRequest.current) return;
      setFrames(result.stackFrames);
      if (result.stackFrames[0]) await selectFrame(result.stackFrames[0]);
    } catch (e) {
      if (request === threadRequest.current) setError(asError(e).message);
    }
  }
  async function evaluateWatches(frame: number, expressions = watchRef.current) {
    const request = ++watchRequest.current;
    const id = session.current;
    const values: Record<string, string> = {};
    for (const expression of expressions) {
      try {
        const response = await dap<{ result: string }>(
          'evaluate',
          { expression, frameId: frame, context: 'watch' },
          id,
        );
        values[expression] = response.result;
      } catch (e) {
        values[expression] = asError(e).message;
      }
    }
    if (id === session.current && request === watchRequest.current) setWatchValues(values);
  }
  async function event(item: DebugEvent, id: string) {
    if (item.event === 'initialized') {
      await syncBreakpoints(id);
      await dap('configurationDone', {}, id);
      configured.current = true;
      setStatus('Running');
    } else if (item.event === 'stopped') {
      setPaused(true);
      setStatus(`Paused · ${String(item.body?.reason ?? 'breakpoint')}`);
      const result = await dap<{ threads: { id: number; name: string }[] }>('threads', {}, id);
      setThreads(result.threads);
      const stoppedThread =
        typeof item.body?.threadId === 'number' ? item.body.threadId : result.threads[0]?.id;
      if (stoppedThread !== undefined) await selectThread(stoppedThread);
    } else if (item.event === 'continued') {
      setPaused(false);
      setStatus('Running');
      ++frameRequest.current;
      ++threadRequest.current;
      ++watchRequest.current;
      callbacks.current.onExecution(null);
    } else if (item.event === 'output')
      setOutput((current) => (current + String(item.body?.output ?? '')).slice(-500000));
    else if (item.event === 'terminated' || item.event === 'exited') {
      setPaused(false);
      setStatus(
        item.event === 'exited'
          ? `Exited · code ${String(item.body?.exitCode ?? '')}`
          : 'Terminated',
      );
      callbacks.current.onExecution(null);
    } else if (item.event === 'transportError')
      setError(String(item.body?.message ?? 'Debugger transport disconnected.'));
  }
  useEffect(() => {
    const life = ++epoch.current;
    let timer: ReturnType<typeof setTimeout>;
    let ownSession: string | null = null;
    let cursor = 0;
    let ended = false;
    async function poll() {
      if (!ownSession || epoch.current !== life) return;
      try {
        const reply = await goTool('debug.poll', { sessionId: ownSession, after: cursor });
        if (epoch.current !== life) return;
        cursor = reply.cursor ?? cursor;
        ended = reply.status === 'stopped' || reply.status === 'exited';
        if (reply.droppedBefore)
          setError(
            'Debugger event history overflowed. Restart the session to restore complete state.',
          );
        for (const item of reply.events ?? []) {
          if (epoch.current !== life) return;
          await event(item, ownSession);
        }
      } catch (e) {
        if (epoch.current === life) setError(asError(e).message);
      } finally {
        if (epoch.current === life && !ended) timer = setTimeout(() => void poll(), 200);
      }
    }
    void (async () => {
      try {
        const reply = await goTool('debug.start', {
          contextId: target.contextId,
          path: target.path,
        });
        if (!reply.sessionId) throw new Error('Debugger did not return a session.');
        ownSession = reply.sessionId;
        if (epoch.current !== life) {
          await goTool('debug.stop', { sessionId: ownSession });
          return;
        }
        session.current = ownSession;
        setStatus('Launching…');
        void poll();
        await dap(
          'launch',
          {
            mode,
            program: target.path,
            args: target.args,
            ...(target.cwd && { cwd: target.cwd }),
            ...(target.env && { env: target.env }),
            stopOnEntry: false,
          },
          ownSession,
        );
      } catch (e) {
        if (epoch.current === life) setError(asError(e).message);
      }
    })();
    return () => {
      ++epoch.current;
      ++frameRequest.current;
      ++threadRequest.current;
      ++watchRequest.current;
      clearTimeout(timer);
      configured.current = false;
      session.current = null;
      callbacks.current.onExecution(null);
      if (ownSession) void goTool('debug.stop', { sessionId: ownSession }).catch(() => {});
    };
  }, [target, mode]);
  useEffect(() => {
    if (configured.current && session.current)
      void syncBreakpoints(session.current).catch((e) => setError(asError(e).message));
  }, [breakpoints]);
  async function control(command: string) {
    setBusy(true);
    setError('');
    try {
      let selectedThread = threadId;
      if (command === 'pause' && selectedThread === undefined) {
        const response = await dap<{ threads: { id: number; name: string }[] }>('threads');
        selectedThread = response.threads[0]?.id;
        if (selectedThread === undefined)
          throw new Error('No running debugger thread is available.');
        setThreadId(selectedThread);
      }
      await dap(command, selectedThread === undefined ? {} : { threadId: selectedThread });
      if (['continue', 'next', 'stepIn', 'stepOut'].includes(command)) {
        setPaused(false);
        setScopes([]);
        callbacks.current.onExecution(null);
      }
    } catch (e) {
      setError(asError(e).message);
    } finally {
      setBusy(false);
    }
  }
  async function stop() {
    const id = session.current;
    setBusy(true);
    try {
      if (id) await goTool('debug.stop', { sessionId: id });
      callbacks.current.onStopped();
    } catch (e) {
      setError(asError(e).message);
      setBusy(false);
    }
  }
  return (
    <section className="debugger" aria-label="Go debugger">
      <div className="debug-toolbar">
        <strong>{status}</strong>
        <button disabled={busy || !paused} onClick={() => void control('continue')}>
          Continue
        </button>
        <button disabled={busy || paused || !session.current} onClick={() => void control('pause')}>
          Pause
        </button>
        <button disabled={busy || !paused} onClick={() => void control('next')}>
          Step over
        </button>
        <button disabled={busy || !paused} onClick={() => void control('stepIn')}>
          Step in
        </button>
        <button disabled={busy || !paused} onClick={() => void control('stepOut')}>
          Step out
        </button>
        <button disabled={busy} onClick={() => void stop()}>
          Stop debugger
        </button>
      </div>
      {error && (
        <p className="inline-notice error-message" role="alert">
          {error}
        </p>
      )}
      {breakpointMessage && <p className="panel-footnote">{breakpointMessage}</p>}
      <div className="debug-columns">
        <div className="debug-stack">
          <select
            aria-label="Debugger thread"
            value={threadId ?? ''}
            disabled={!paused}
            onChange={(e) => void selectThread(Number(e.target.value))}
          >
            {threads.map((thread) => (
              <option key={thread.id} value={thread.id}>
                {thread.name}
              </option>
            ))}
          </select>
          {frames.map((frame) => (
            <button
              key={frame.id}
              disabled={!paused}
              className={frameId === frame.id ? 'selected' : ''}
              onClick={() => void selectFrame(frame)}
            >
              <strong>{frame.name}</strong>
              <small>
                {frame.source?.path?.split('/').pop()}:{frame.line}
              </small>
            </button>
          ))}
        </div>
        <div className="debug-variables">
          {scopes.map((scope) => (
            <ScopeVariables
              key={`${frameId}:${scope.variablesReference}`}
              scope={scope}
              frame={frameId ?? 0}
              request={dap}
            />
          ))}
          {!scopes.length && <p className="empty-note">Variables are available when paused.</p>}
        </div>
        <div className="debug-watches">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const expression = watchInput.trim();
              if (!expression) return;
              const next = [...new Set([...watches, expression])];
              setWatches(next);
              watchRef.current = next;
              setWatchInput('');
              if (paused && frameId !== undefined) void evaluateWatches(frameId, next);
            }}
          >
            <input
              aria-label="Watch expression"
              value={watchInput}
              onChange={(e) => setWatchInput(e.target.value)}
              placeholder="Watch expression"
            />
            <button>Add</button>
          </form>
          {watches.map((expression) => (
            <div key={expression}>
              <code>{expression}</code>
              <button
                aria-label={`Remove watch ${expression}`}
                onClick={() =>
                  setWatches((current) => current.filter((item) => item !== expression))
                }
              >
                ×
              </button>
              <pre>{watchValues[expression] ?? 'Pause to evaluate'}</pre>
            </div>
          ))}
        </div>
      </div>
      <details className="debug-output">
        <summary>Debugger output</summary>
        <pre>{output || 'No output yet.'}</pre>
      </details>
    </section>
  );
}
function VariableList({
  reference,
  frame,
  request,
  depth = 0,
}: {
  reference: number;
  frame: number;
  request<T>(command: string, args: Record<string, unknown>): Promise<T>;
  depth?: number;
}) {
  const [variables, setVariables] = useState<DebugVariable[]>([]);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(new Set<number>());
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const read = useRef(request);
  read.current = request;
  useEffect(() => {
    let alive = true;
    void read
      .current<{ variables: DebugVariable[] }>('variables', {
        variablesReference: reference,
        start: offset,
        count: 100,
      })
      .then((result) => {
        if (alive) {
          setVariables(result.variables.slice(0, 100));
          setHasMore(result.variables.length >= 100);
        }
      })
      .catch((e) => {
        if (alive) setError(asError(e).message);
      });
    return () => {
      alive = false;
    };
  }, [reference, frame, offset]);
  return (
    <div className="variable-list">
      {error && <p className="error-message">{error}</p>}
      {variables.map((variable, index) => (
        <div key={`${variable.name}:${index}`}>
          <button
            disabled={!variable.variablesReference || depth >= 8}
            onClick={() =>
              setExpanded((current) => {
                const next = new Set(current);
                if (next.has(index)) next.delete(index);
                else next.add(index);
                return next;
              })
            }
          >
            <span>{variable.variablesReference ? (expanded.has(index) ? '▾' : '▸') : '·'}</span>
            <strong>{variable.name}</strong>
            <code title={variable.type}>{variable.value}</code>
          </button>
          {expanded.has(index) && (
            <VariableList
              reference={variable.variablesReference}
              frame={frame}
              request={request}
              depth={depth + 1}
            />
          )}
        </div>
      ))}
      {offset > 0 && (
        <button onClick={() => setOffset(Math.max(0, offset - 100))}>Previous values</button>
      )}
      {hasMore && <button onClick={() => setOffset(offset + 100)}>Next values</button>}
    </div>
  );
}

function ScopeVariables({
  scope,
  frame,
  request,
}: {
  scope: Scope;
  frame: number;
  request<T>(command: string, args: Record<string, unknown>): Promise<T>;
}) {
  const [open, setOpen] = useState(!scope.expensive);
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{scope.name}</summary>
      {open && (
        <VariableList reference={scope.variablesReference} frame={frame} request={request} />
      )}
    </details>
  );
}
