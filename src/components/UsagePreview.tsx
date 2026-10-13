import { useEffect, useRef, useState } from 'react';
import { EditorState, RangeSetBuilder, type Extension } from '@codemirror/state';
import { Decoration, EditorView, lineNumbers } from '@codemirror/view';
import type { Position, SourceLocation } from '../contracts';
import { offsetAt, positionAt } from '../editor/editor-store';
import { syntaxColors } from '../editor/syntax-colors';
import { syntaxFor } from '../editor/syntax';

/** Lines shown above and below the usage, as in IntelliJ's usage preview. */
export const PREVIEW_CONTEXT = 5;

const theme = (dark: boolean): Extension => [
  syntaxColors(),
  EditorView.theme(
    {
      '&': { height: '100%', backgroundColor: 'var(--editor)', color: 'var(--text)' },
      '.cm-scroller': {
        fontFamily: '"SFMono-Regular", Menlo, Monaco, Consolas, monospace',
        lineHeight: '1.65',
      },
      '.cm-gutters': { backgroundColor: 'var(--editor)', color: 'var(--muted)', border: 'none' },
      '.usage-preview-line': { backgroundColor: 'var(--active-line)' },
      '.usage-preview-match': {
        backgroundColor: 'var(--selection)',
        borderRadius: '2px',
      },
      '&.cm-focused': { outline: 'none' },
    },
    { dark },
  ),
];

/** Read-only, syntax-highlighted file excerpt around a usage. ⌘-click navigates like the editor. */
export function UsagePreview({
  location,
  dark,
  load,
  onNavigate,
}: {
  location: SourceLocation;
  dark: boolean;
  /** Current buffer text, including unsaved edits, for a workspace file. */
  load(path: string): Promise<string>;
  onNavigate(path: string, position: Position): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const navigate = useRef(onNavigate);
  navigate.current = onNavigate;
  const { path, range } = location;
  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    let alive = true;
    let view: EditorView | undefined;
    setError('');
    void Promise.all([load(path), syntaxFor(path).catch((): Extension => [])])
      .then(([text, syntax]) => {
        if (!alive) return;
        const state = EditorState.create({ doc: text });
        const from = offsetAt(state, range.start);
        const to = Math.max(from, offsetAt(state, range.end));
        const line = state.doc.lineAt(from);
        const marks = new RangeSetBuilder<Decoration>();
        marks.add(line.from, line.from, Decoration.line({ class: 'usage-preview-line' }));
        if (to > from) marks.add(from, to, Decoration.mark({ class: 'usage-preview-match' }));
        view = new EditorView({
          parent,
          state: EditorState.create({
            doc: text,
            extensions: [
              lineNumbers(),
              EditorState.readOnly.of(true),
              EditorView.editable.of(false),
              theme(dark),
              syntax,
              EditorView.decorations.of(marks.finish()),
              EditorView.domEventHandlers({
                mousedown(event, target) {
                  if (!event.metaKey || event.button !== 0) return false;
                  const offset = target.posAtCoords({ x: event.clientX, y: event.clientY });
                  if (offset === null) return false;
                  event.preventDefault();
                  navigate.current(path, positionAt(target.state, offset));
                  return true;
                },
              }),
            ],
          }),
        });
        view.dispatch({ effects: EditorView.scrollIntoView(from, { y: 'center' }) });
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      alive = false;
      view?.destroy();
    };
  }, [path, range.start.line, range.start.character, range.end.line, range.end.character, dark]);
  return (
    <div className="usage-preview" aria-label={`Preview of ${path}`}>
      {error ? (
        <p className="empty-note">{error}</p>
      ) : (
        <div className="usage-preview-body" ref={host} />
      )}
    </div>
  );
}
