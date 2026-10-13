import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from '../api';
import { asError } from '../model/document-session';
import { Icon } from './Icon';
export function TerminalPanel({
  visible,
  dark,
  onClose,
}: {
  visible: boolean;
  dark: boolean;
  onClose(): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fitter = useRef<FitAddon | null>(null);
  const visibility = useRef(visible);
  visibility.current = visible;
  const [epoch, setEpoch] = useState(0);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(true);
  const [exitCode, setExitCode] = useState<number>();
  useEffect(() => {
    if (!host.current) return;
    let alive = true;
    let id: string | undefined;
    let timer: ReturnType<typeof setTimeout>;
    let writes: Promise<void> = Promise.resolve();
    let cursor = 0;
    setError('');
    setRunning(true);
    setExitCode(undefined);
    const term = new Terminal({
      fontFamily: 'SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 5000,
      screenReaderMode: true,
      cursorBlink: false,
      allowProposedApi: false,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    terminal.current = term;
    fitter.current = fit;
    fit.fit();
    const pendingRenders = new Set<() => void>();
    const render = (data: Uint8Array | string) =>
      new Promise<void>((resolve) => {
        const done = () => {
          pendingRenders.delete(done);
          resolve();
        };
        pendingRenders.add(done);
        term.write(data, done);
      });
    async function poll() {
      if (!alive || !id) return;
      if (!visibility.current) {
        timer = setTimeout(() => void poll(), 400);
        return;
      }
      try {
        const result = await api.readTerminal(id, cursor);
        if (!alive) return;
        if (result.dropped)
          await render(
            '\x1b[0m\r\n[Earlier output exceeded the terminal buffer and was truncated.]\r\n',
          );
        if (result.bytes.length) await render(new Uint8Array(result.bytes));
        if (!alive) return;
        cursor = result.cursor;
        if (!result.running) {
          setRunning(false);
          setExitCode(result.exitCode);
          return;
        }
        timer = setTimeout(() => void poll(), result.bytes.length ? 16 : 100);
      } catch (e) {
        if (alive) {
          setError(asError(e).message);
          setRunning(false);
        }
      }
    }
    const start = api
      .startTerminal(term.rows, term.cols)
      .then((session) => {
        if (!alive) {
          void api.stopTerminal(session.id).catch(() => {});
          return;
        }
        id = session.id;
        term.focus();
        void poll();
      })
      .catch((e) => {
        if (alive) {
          setError(asError(e).message);
          setRunning(false);
        }
      });
    function send(bytes: number[]) {
      writes = writes
        .then(async () => {
          await start;
          if (alive && id) await api.writeTerminal(id, bytes);
        })
        .catch((e) => {
          if (alive) setError(asError(e).message);
        });
    }
    const input = term.onData((data) => send([...new TextEncoder().encode(data)]));
    const binary = term.onBinary((data) =>
      send([...data].map((character) => character.charCodeAt(0) & 255)),
    );
    const resize = term.onResize((size) => {
      if (id && alive)
        void api.resizeTerminal(id, size.rows, size.cols).catch((e) => {
          if (alive) setError(asError(e).message);
        });
    });
    const observer = new ResizeObserver(() => {
      if (visibility.current && alive) fit.fit();
    });
    observer.observe(host.current);
    return () => {
      alive = false;
      clearTimeout(timer);
      observer.disconnect();
      input.dispose();
      binary.dispose();
      resize.dispose();
      if (id) void api.stopTerminal(id).catch(() => {});
      term.dispose();
      for (const resolve of pendingRenders) resolve();
      pendingRenders.clear();
      terminal.current = null;
      fitter.current = null;
    };
  }, [epoch]);
  useEffect(() => {
    if (visible) {
      fitter.current?.fit();
      terminal.current?.focus();
    }
  }, [visible]);
  useEffect(() => {
    if (terminal.current) terminal.current.options.theme = terminalTheme(dark);
  }, [dark]);
  return (
    <section className="terminal-panel" aria-label="Terminal">
      <div className="results-summary">
        <Icon name="terminal" />
        <strong>Terminal</strong>
        <span>
          {running ? 'Interactive shell' : `Exited${exitCode === undefined ? '' : ` ${exitCode}`}`}
        </span>
        <div className="spacer" />
        <button onClick={() => terminal.current?.clear()}>Clear</button>
        {!running && <button onClick={() => setEpoch((value) => value + 1)}>New session</button>}
        <button title="Terminate this terminal and its foreground processes" onClick={onClose}>
          Close session
        </button>
      </div>
      {error && (
        <p className="inline-notice error-message" role="alert">
          {error}
        </p>
      )}
      <div className="terminal-host" ref={host} />
    </section>
  );
}
function terminalTheme(dark = document.documentElement.dataset.theme !== 'light') {
  return {
    background: dark ? '#202226' : '#ffffff',
    foreground: dark ? '#dedfe3' : '#252932',
    cursor: dark ? '#dedfe3' : '#252932',
    selectionBackground: dark ? '#35547b' : '#cbdcf9',
    black: dark ? '#454950' : '#252932',
    red: dark ? '#ed9999' : '#b83434',
    green: dark ? '#91c48b' : '#267444',
    yellow: dark ? '#d3bd83' : '#876018',
    blue: dark ? '#8fb7ee' : '#285fba',
    magenta: dark ? '#c8a8e8' : '#8b3990',
    cyan: dark ? '#86c9cd' : '#126b70',
    white: dark ? '#dedfe3' : '#606874',
  };
}
