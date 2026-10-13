import { useEffect, useRef, useState } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { MergeView, unifiedMergeView } from '@codemirror/merge';
import type { GitDiff } from '../contracts';
import { syntaxColors } from '../editor/syntax-colors';
import { syntaxFor } from '../editor/syntax';

function theme(dark: boolean): Extension {
  return [
    syntaxColors(dark),
    EditorView.theme(
      {
        '&': { backgroundColor: 'var(--editor)', color: 'var(--text)' },
        '.cm-scroller': {
          fontFamily: '"SFMono-Regular", Menlo, Monaco, Consolas, monospace',
          lineHeight: '1.65',
        },
        '.cm-line': { padding: '0 12px' },
        '.cm-gutters': {
          backgroundColor: 'var(--editor)',
          color: 'var(--muted)',
          border: 'none',
        },
        '&.cm-focused': { outline: 'none' },
      },
      { dark },
    ),
  ];
}

/** Read-only comparison of a file's HEAD content against its working tree, shown in the main editor area. */
export function DiffEditor({ diff, dark }: { diff: GitDiff; dark: boolean }) {
  const [mode, setMode] = useState<'side' | 'unified'>('side');
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const parent = host.current;
    if (!parent || diff.binary) return;
    let alive = true;
    let destroy = () => {};
    void syntaxFor(diff.path)
      .catch((): Extension => [])
      .then((syntax) => {
        if (!alive) return;
        const base = [
          lineNumbers(),
          EditorView.editable.of(false),
          EditorState.readOnly.of(true),
          EditorView.lineWrapping,
          theme(dark),
          syntax,
        ];
        if (mode === 'side') {
          const view = new MergeView({
            a: { doc: diff.before, extensions: base },
            b: { doc: diff.after, extensions: base },
            parent,
            highlightChanges: true,
            gutter: true,
          });
          destroy = () => view.destroy();
        } else {
          const view = new EditorView({
            doc: diff.after,
            parent,
            extensions: [
              ...base,
              unifiedMergeView({ original: diff.before, mergeControls: false }),
            ],
          });
          destroy = () => view.destroy();
        }
      });
    return () => {
      alive = false;
      destroy();
    };
  }, [diff, mode, dark]);
  return (
    <div className="diff-editor">
      <div className="diff-editor-bar">
        <strong>{diff.path}</strong>
        <span className="muted">
          {mode === 'side' ? 'HEAD ⟷ Working tree' : 'Working tree with changes inline'}
        </span>
        <div className="spacer" />
        <button aria-pressed={mode === 'side'} onClick={() => setMode('side')}>
          Side by side
        </button>
        <button aria-pressed={mode === 'unified'} onClick={() => setMode('unified')}>
          Unified
        </button>
      </div>
      {diff.binary ? (
        <p className="empty-note">Binary file · text diff unavailable</p>
      ) : (
        <div className="diff-editor-body" ref={host} />
      )}
    </div>
  );
}
