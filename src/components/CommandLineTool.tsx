import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { asError } from '../model/document-session';

interface CommandLineStatus {
  path: string;
  installed: boolean;
  unavailable: string | null;
}

export function CommandLineTool() {
  const [status, setStatus] = useState<CommandLineStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    let alive = true;
    void invoke<CommandLineStatus>('command_line_status').then(
      (next) => {
        if (alive) setStatus(next);
      },
      (e) => {
        if (alive) setError(asError(e).message);
      },
    );
    return () => {
      alive = false;
    };
  }, []);
  async function install() {
    setBusy(true);
    setError('');
    try {
      setStatus(await invoke<CommandLineStatus>('install_command_line_tool'));
    } catch (e) {
      setError(asError(e).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="settings-section">
      <h3>Command-line tool</h3>
      <p className="muted">Open a project or file in Zwip from your terminal.</p>
      {!('__TAURI_INTERNALS__' in window) && (
        <p className="muted">Open Settings in the Zwip desktop app to install.</p>
      )}
      <ul className="command-line-usage">
        <li>
          <code>zwip .</code>
          <span>Open the current directory as a workspace</span>
        </li>
        <li>
          <code>zwip path/to/project</code>
          <span>Open a project directory</span>
        </li>
        <li>
          <code>zwip path/to/file</code>
          <span>Open a file in an existing workspace or its parent folder</span>
        </li>
      </ul>
      {status?.unavailable ? (
        <p className="muted">{status.unavailable}</p>
      ) : status?.installed ? (
        <p role="status">
          Installed at <code>{status.path}</code>
        </p>
      ) : (
        <button type="button" disabled={!status || busy} onClick={() => void install()}>
          {busy ? 'Installing…' : 'Install zwip command'}
        </button>
      )}
      {status && !status.unavailable && !status.installed && (
        <p className="muted">
          Installs immediately to <code>{status.path}</code>. No administrator password needed.
        </p>
      )}
      <details className="command-line-setup">
        <summary>Terminal setup instructions</summary>
        <p className="muted">
          After installing, try <code>zwip .</code>. If your terminal says “command not found”, run:
        </p>
        <pre>
          <code>export PATH="$HOME/.local/bin:$PATH"</code>
        </pre>
        <p className="muted">
          Add the same line to <code>~/.zshrc</code> (or your shell’s startup file) to keep it for
          new terminals. Paths containing spaces need quotes, for example{' '}
          <code>zwip "My Project"</code>. Running <code>zwip</code> without a path opens the current
          directory.
        </p>
        <p className="muted">
          If you move Zwip.app, install the command again from the app’s new location. To uninstall,
          remove <code>~/.local/bin/zwip</code>.
        </p>
      </details>
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
    </div>
  );
}
