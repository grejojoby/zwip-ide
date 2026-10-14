import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { IntelliJImport } from './IntelliJImport';
import {
  defaultShortcuts,
  doubleTapRecognizer,
  globalShortcutActions,
  shortcutActions,
  shortcutConflicts,
  shortcutFromEvent,
  shortcutLabel,
  validShortcut,
  type ShortcutAction,
  type Shortcuts,
} from '../model/shortcuts';
import { asError } from '../model/document-session';
import type { ExcludedDirectory } from '../contracts';
import type { WorkspaceRunSession } from '../model/run-configurations';
export interface HistoryPreferences {
  retentionDays: number;
  maxBytes: number;
}
export function Settings({
  shortcuts,
  history,
  dark,
  stickyLines = false,
  onStickyLines,
  indexOnOpen = true,
  onIndexOnOpen,
  workspaceRoot,
  runSession,
  excludedDirectories,
  onInclude,
  onTheme,
  onSave,
  onClose,
}: {
  shortcuts: Shortcuts;
  history: HistoryPreferences;
  dark: boolean;
  stickyLines?: boolean;
  onStickyLines?(enabled: boolean): void;
  indexOnOpen?: boolean;
  onIndexOnOpen?(enabled: boolean): void;
  workspaceRoot?: string;
  runSession?: WorkspaceRunSession;
  excludedDirectories?: ExcludedDirectory[];
  onInclude?(relativePath: string): Promise<void>;
  onTheme(dark: boolean): void;
  onSave(shortcuts: Shortcuts, history: HistoryPreferences): Promise<void>;
  onClose(): void;
}) {
  const [draft, setDraft] = useState(shortcuts);
  const [retentionDays, setRetentionDays] = useState(history.retentionDays);
  const [size, setSize] = useState(history.maxBytes / 1024 / 1024);
  const [capturing, setCapturing] = useState<ShortcutAction | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importNote, setImportNote] = useState('');
  const conflicts = shortcutConflicts(draft);
  // Listen on the window while recording: WebKit does not focus a button when it is clicked, so
  // a key handler on the button itself would never run in the desktop app.
  useEffect(() => {
    if (!capturing) return;
    const tap = doubleTapRecognizer();
    const record = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const doubled = tap(event);
      if (event.type === 'keyup') {
        if (!doubled) return;
        if (!globalShortcutActions.includes(capturing)) {
          setError(
            'Double-tap shortcuts work for window actions such as Go to file, not editor actions.',
          );
          return;
        }
        setDraft((current) => ({ ...current, [capturing]: doubled }));
        setCapturing(null);
        setError('');
        return;
      }
      if (event.key === 'Escape') {
        setCapturing(null);
        return;
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        setDraft((current) => ({ ...current, [capturing]: '' }));
        setCapturing(null);
        return;
      }
      const shortcut = shortcutFromEvent(event);
      if (!shortcut) return;
      if (!validShortcut(shortcut)) {
        setError('This shortcut key is not supported.');
        return;
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && !/^F\d{1,2}$/.test(event.key)) {
        setError('Use a modifier key or a function key so normal typing remains available.');
        return;
      }
      setDraft((current) => ({ ...current, [capturing]: shortcut }));
      setCapturing(null);
      setError('');
    };
    // Clicking anywhere else cancels recording, as losing focus used to.
    const cancel = (event: MouseEvent) => {
      if (!(event.target as Element | null)?.closest('.shortcut-list button')) setCapturing(null);
    };
    window.addEventListener('keydown', record, true);
    window.addEventListener('keyup', record, true);
    window.addEventListener('mousedown', cancel, true);
    return () => {
      window.removeEventListener('keydown', record, true);
      window.removeEventListener('keyup', record, true);
      window.removeEventListener('mousedown', cancel, true);
    };
  }, [capturing]);
  async function save() {
    setBusy(true);
    setError('');
    try {
      if (conflicts.length) throw new Error('Resolve shortcut conflicts before saving.');
      await onSave(draft, { retentionDays, maxBytes: size * 1024 * 1024 });
      onClose();
    } catch (e) {
      setError(asError(e).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Modal
        title="Settings"
        wide
        onClose={() => {
          if (!busy) onClose();
        }}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="modal-body settings-body">
            <div className="settings-section">
              <h3>Bring your IntelliJ settings</h3>
              <p className="muted">
                Review keybindings, database connections, run/debug configurations and compatible
                appearance settings before importing.
              </p>
              <button type="button" disabled={busy} onClick={() => setShowImport(true)}>
                Import from IntelliJ…
              </button>
              {importNote && <p role="status">{importNote}</p>}
            </div>
            <div className="settings-section">
              <h3>Appearance</h3>
              <label className="checkbox-label">
                <input type="checkbox" checked={dark} onChange={(e) => onTheme(e.target.checked)} />
                Dark theme
              </label>
              {onStickyLines && (
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={stickyLines}
                    onChange={(e) => onStickyLines(e.target.checked)}
                  />
                  Sticky function headers while scrolling
                </label>
              )}
            </div>
            {onIndexOnOpen && (
              <div className="settings-section">
                <h3>Indexing</h3>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={indexOnOpen}
                    onChange={(e) => onIndexOnOpen(e.target.checked)}
                  />
                  Index the whole project when it opens
                </label>
                <p className="muted">
                  Loads every module and type-checks its packages in the background, so navigation
                  and search are ready before you open files. Results are cached across restarts.
                </p>
              </div>
            )}
            <div className="settings-section">
              <h3>Keyboard shortcuts</h3>
              <p className="muted">
                Default macOS shortcuts. Select a shortcut and press its replacement. Escape cancels
                recording; Delete clears a binding.
              </p>
              <div className="shortcut-list">
                {(Object.keys(shortcutActions) as ShortcutAction[]).map((action) => (
                  <div key={action}>
                    <span>{shortcutActions[action]}</span>
                    <button
                      type="button"
                      className={capturing === action ? 'recording-shortcut' : ''}
                      aria-label={`Shortcut for ${shortcutActions[action]}`}
                      onClick={() => setCapturing(action)}
                    >
                      <kbd>
                        {capturing === action
                          ? 'Press shortcut…'
                          : draft[action]
                            ? shortcutLabel(draft[action])
                            : 'Unassigned'}
                      </kbd>
                    </button>
                  </div>
                ))}
              </div>
              <button type="button" onClick={() => setDraft({ ...defaultShortcuts })}>
                Restore default shortcuts
              </button>
              {conflicts.map((conflict) => (
                <p key={conflict} className="error-message">
                  {conflict}
                </p>
              ))}
            </div>
            {excludedDirectories && (
              <div className="settings-section">
                <h3>Excluded from search and indexing</h3>
                <p className="muted">
                  Dependency and build directories are always skipped. Right-click a folder in the
                  project tree to exclude it. Paths matched by .gitignore are skipped but not listed
                  here.
                </p>
                {excludedDirectories.length ? (
                  <ul className="excluded-list" aria-label="Excluded directories">
                    {excludedDirectories.map((item) => (
                      <li key={item.path}>
                        <code title={item.path}>{item.path}</code>
                        <span className="muted">{item.reason}</span>
                        {item.reason === 'Excluded by you' && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={async () => {
                              setBusy(true);
                              setError('');
                              try {
                                await onInclude?.(item.path);
                              } catch (e) {
                                setError(asError(e).message);
                              } finally {
                                setBusy(false);
                              }
                            }}
                          >
                            Include again
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">No directories are excluded.</p>
                )}
              </div>
            )}
            <div className="settings-section">
              <h3>Local History</h3>
              <div className="history-settings">
                <label className="field-label">
                  Retain saved revisions (days)
                  <input
                    type="number"
                    min={1}
                    max={365}
                    step={1}
                    required
                    value={retentionDays}
                    onChange={(e) => setRetentionDays(Number(e.target.value))}
                  />
                </label>
                <label className="field-label">
                  Maximum saved history (MiB)
                  <input
                    type="number"
                    min={16}
                    max={1024}
                    step={1}
                    required
                    value={size}
                    onChange={(e) => setSize(Number(e.target.value))}
                  />
                </label>
              </div>
              <p className="muted">
                Unsaved recovery records stay until recovered or explicitly discarded.
              </p>
            </div>
            {error && (
              <p role="alert" className="error-message">
                {error}
              </p>
            )}
          </div>
          <div className="modal-actions">
            <button type="button" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button className="primary" disabled={busy || !!conflicts.length}>
              {busy ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </form>
      </Modal>
      {showImport && (
        <IntelliJImport
          shortcuts={draft}
          workspaceRoot={workspaceRoot}
          runSession={runSession}
          onKeymap={(keys) => {
            setDraft(keys);
            setCapturing(null);
            setImportNote(
              'Keybindings added to this draft. Review any conflicts, then choose Save settings to apply them.',
            );
          }}
          onAppearance={onTheme}
          onClose={() => setShowImport(false)}
        />
      )}
    </>
  );
}
