import { useEffect, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, undo } from '@codemirror/commands';
import { mergeConflicts } from '../model/merge';
import { Modal } from './Modal';

import type { MergeSession } from '../contracts';
export interface MergeResolution {
  resolution: 'result' | 'ours' | 'theirs' | 'delete';
  result?: string;
}
export function MergeEditor({
  session,
  onApply,
  onClose,
  busy,
  error,
}: {
  session: MergeSession;
  onApply(resolution: MergeResolution): void;
  onClose(): void;
  busy: boolean;
  error: string;
}) {
  const ours = useRef<HTMLDivElement>(null);
  const result = useRef<HTMLDivElement>(null);
  const theirs = useRef<HTMLDivElement>(null);
  const views = useRef<EditorView[]>([]);
  const resultView = useRef<EditorView | null>(null);
  const [conflicts, setConflicts] = useState(() => mergeConflicts(session.result ?? '').length);
  const [current, setCurrent] = useState(0);
  const text = session.kind === 'text';
  useEffect(() => {
    if (!text || !ours.current || !result.current || !theirs.current) return;
    let syncing = false;
    const theme = EditorView.theme({
      '&': { height: '100%', background: 'var(--editor)', color: 'var(--text)' },
      '.cm-scroller': { fontFamily: 'Menlo, monospace', fontSize: '11px', lineHeight: '1.7' },
      '.cm-gutters': { background: 'var(--surface)', color: 'var(--muted)', border: 'none' },
      '.cm-content': { padding: '8px 0' },
      '.cm-cursor': { borderLeftColor: 'var(--text)' },
    });
    const sources = [
      { parent: ours.current, value: session.ours, label: session.labels.ours, editable: false },
      { parent: result.current, value: session.result, label: 'Merge result', editable: true },
      {
        parent: theirs.current,
        value: session.theirs,
        label: session.labels.theirs,
        editable: false,
      },
    ];
    for (const source of sources) {
      const view = new EditorView({
        parent: source.parent,
        state: EditorState.create({
          doc: source.value ?? '',
          extensions: [
            lineNumbers(),
            theme,
            history(),
            keymap.of([...defaultKeymap, ...historyKeymap]),
            EditorState.readOnly.of(!source.editable),
            EditorView.editable.of(source.editable),
            EditorView.contentAttributes.of({ 'aria-label': source.label }),
            EditorView.domEventHandlers({
              scroll: (_event, sourceView) => {
                if (syncing) return;
                syncing = true;
                const sourceScroll = sourceView.scrollDOM;
                const fraction =
                  sourceScroll.scrollTop /
                  Math.max(1, sourceScroll.scrollHeight - sourceScroll.clientHeight);
                for (const other of views.current)
                  if (other !== sourceView) {
                    other.scrollDOM.scrollTop =
                      fraction * (other.scrollDOM.scrollHeight - other.scrollDOM.clientHeight);
                    other.scrollDOM.scrollLeft = sourceScroll.scrollLeft;
                  }
                requestAnimationFrame(() => {
                  syncing = false;
                });
              },
            }),
            EditorView.updateListener.of((update) => {
              if (source.editable && update.docChanged) {
                const remaining = mergeConflicts(update.state.doc.toString()).length;
                setConflicts(remaining);
                setCurrent((index) => Math.max(0, Math.min(index, remaining - 1)));
              }
            }),
          ],
        }),
      });
      views.current.push(view);
      if (source.editable) resultView.current = view;
    }
    return () => {
      for (const view of views.current) view.destroy();
      views.current = [];
      resultView.current = null;
    };
  }, [session, text]);
  function selectConflict(index: number) {
    const view = resultView.current;
    if (!view) return;
    const items = mergeConflicts(view.state.doc.toString());
    const conflict = items[index];
    if (!conflict) return;
    setCurrent(index);
    view.dispatch({
      selection: { anchor: conflict.from },
      effects: EditorView.scrollIntoView(conflict.from, { y: 'center' }),
    });
    view.focus();
  }
  function accept(side: 'ours' | 'theirs') {
    const view = resultView.current;
    if (!view) return;
    const conflict = mergeConflicts(view.state.doc.toString())[current];
    if (conflict)
      view.dispatch({ changes: { from: conflict.from, to: conflict.to, insert: conflict[side] } });
  }
  function wholeFile(side: 'ours' | 'theirs') {
    const view = resultView.current;
    if (view)
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: session[side] ?? '' },
      });
  }
  return (
    <Modal
      title={`Resolve conflict · ${session.path}`}
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      <div className="merge-toolbar">
        <span>
          {session.operation} · {session.conflictType}
        </span>
        {text && (
          <>
            <strong>{conflicts} unresolved</strong>
            <button
              disabled={!conflicts || current === 0}
              onClick={() => selectConflict(current - 1)}
            >
              Previous
            </button>
            <button disabled={!conflicts} onClick={() => selectConflict((current + 1) % conflicts)}>
              Next
            </button>
            <button disabled={!conflicts} onClick={() => accept('ours')}>
              Accept current
            </button>
            <button disabled={!conflicts} onClick={() => accept('theirs')}>
              Accept incoming
            </button>
            <button onClick={() => resultView.current && undo(resultView.current)}>Undo</button>
          </>
        )}
      </div>
      {text ? (
        <div className="merge-panes">
          <div className="merge-pane">
            <div className="merge-pane-title">
              <strong>{session.labels.ours}</strong>
              <button disabled={session.ours === null} onClick={() => wholeFile('ours')}>
                Use file
              </button>
            </div>
            {session.ours === null && <div className="inline-notice">Deleted on this side</div>}
            <div className="merge-code" ref={ours} />
          </div>
          <div className="merge-pane">
            <div className="merge-pane-title">
              <strong>Result</strong>
              <span>Editable</span>
            </div>
            <div className="merge-code" ref={result} />
          </div>
          <div className="merge-pane">
            <div className="merge-pane-title">
              <strong>{session.labels.theirs}</strong>
              <button disabled={session.theirs === null} onClick={() => wholeFile('theirs')}>
                Use file
              </button>
            </div>
            {session.theirs === null && <div className="inline-notice">Deleted on this side</div>}
            <div className="merge-code" ref={theirs} />
          </div>
        </div>
      ) : (
        <div className="modal-body">
          <p>This {session.kind} conflict needs an explicit file-level resolution.</p>
          <p>Choose the revision to keep, or delete the file.</p>
        </div>
      )}
      {session.base !== null && text && (
        <details className="merge-base">
          <summary>View base · {session.labels.base}</summary>
          <pre>{session.base}</pre>
        </details>
      )}
      {error && (
        <p className="inline-notice error-message" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <span>
          {text
            ? 'Review the result before applying. Unrelated changes are preserved.'
            : session.path}
        </span>
        <button disabled={busy} onClick={onClose}>
          Cancel
        </button>
        {(!text || session.ours === null || session.theirs === null) && (
          <>
            <button disabled={busy} onClick={() => onApply({ resolution: 'ours' })}>
              Keep current
            </button>
            <button disabled={busy} onClick={() => onApply({ resolution: 'theirs' })}>
              Keep incoming
            </button>
            <button disabled={busy} onClick={() => onApply({ resolution: 'delete' })}>
              Delete file
            </button>
          </>
        )}
        {text && (
          <button
            className="primary"
            disabled={busy || conflicts > 0}
            onClick={() =>
              onApply({
                resolution: 'result',
                result: resultView.current?.state.doc.toString() ?? '',
              })
            }
          >
            {busy ? 'Applying…' : 'Apply resolution'}
          </button>
        )}
      </div>
    </Modal>
  );
}
