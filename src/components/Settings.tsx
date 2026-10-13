import { useState } from 'react';
import { Modal } from './Modal';
import { IntelliJImport } from './IntelliJImport';
import {
  defaultShortcuts,
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
            </div>
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
                      onBlur={() => setCapturing(null)}
                      onKeyDown={(event) => {
                        if (capturing !== action) return;
                        event.preventDefault();
                        event.stopPropagation();
                        if (event.key === 'Escape') {
                          setCapturing(null);
                          return;
                        }
                        if (event.key === 'Backspace' || event.key === 'Delete') {
                          setDraft((current) => ({ ...current, [action]: '' }));
                          setCapturing(null);
                          return;
                        }
                        const shortcut = shortcutFromEvent(event.nativeEvent);
                        if (!shortcut) return;
                        if (!validShortcut(shortcut)) {
                          setError('This shortcut key is not supported.');
                          return;
                        }
                        if (
                          !event.metaKey &&
                          !event.ctrlKey &&
                          !event.altKey &&
                          !/^F\d{1,2}$/.test(event.key)
                        ) {
                          setError(
                            'Use a modifier key or a function key so normal typing remains available.',
                          );
                          return;
                        }
                        setDraft((current) => ({ ...current, [action]: shortcut }));
                        setCapturing(null);
                        setError('');
                      }}
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
