import { useEffect, useRef } from 'react';
import { unifiedMergeView } from '@codemirror/merge';
import { Annotation, Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightSpecialChars,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { syntaxFor, observeSyntaxChanges } from './syntax';
import {
  breakpointLines,
  debugGutters,
  setBreakpoints,
  setCoverage,
  setExecutionLine,
} from './debug-gutters';
import { externalDocumentChange } from './external-change';
import { blameGutter, setBlame, type BlameLine } from './blame-gutter';
import { stickyLines } from './sticky-lines';
import { semanticExtensions, type SemanticCallbacks } from './semantic-extensions';
import { defaultShortcuts, type Shortcuts } from '../model/shortcuts';
import { syntaxColors } from './syntax-colors';
import { navigationHighlight, revealNavigationTarget } from './navigation-highlight';
import type { NavigationOperation, Position, TextDelta } from '../contracts';
import { offsetAt, positionAt, type OpenEditor } from './editor-store';
import { currentEditorFontSize, editorFontSizeAfterWheel, setEditorFontSize } from '../model/zoom';
const mirrored = Annotation.define<boolean>();

function theme(dark: boolean): Extension {
  return [
    syntaxColors(),
    EditorView.theme(
      {
        '&': { height: '100%', backgroundColor: 'var(--editor)', color: 'var(--syntax-text)' },
        '.cm-scroller': {
          fontFamily: '"SFMono-Regular", Menlo, Monaco, Consolas, monospace',
          fontSize: 'var(--editor-font-size, 12px)',
          lineHeight: '1.65',
        },
        '.cm-content': { padding: '12px 0', caretColor: 'var(--text)' },
        '.cm-line': { padding: '0 12px' },
        '.cm-gutters': {
          backgroundColor: 'var(--editor)',
          color: 'var(--muted)',
          border: 'none',
          paddingRight: '8px',
        },
        '.cm-lineNumbers .cm-gutterElement': { minWidth: '3em' },
        '.cm-activeLineGutter': { backgroundColor: 'var(--active-line)' },
        // The selection layer sits behind the text lines; an opaque current-line background
        // would hide the selection on the caret's line.
        '.cm-activeLine': {
          backgroundColor: 'color-mix(in srgb, var(--active-line) 60%, transparent)',
        },
        // Other occurrences of the selected text, as IntelliJ marks them.
        '.cm-selectionMatch': { backgroundColor: 'var(--selection-match)' },
        '.cm-cursor': { borderLeftColor: 'var(--text)' },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
          backgroundColor: 'var(--selection)',
        },
        '.cm-tooltip': { backgroundColor: 'var(--surface)', border: '1px solid var(--border)' },
        '.cm-panels': { backgroundColor: 'var(--surface)', color: 'var(--text)' },
        '&.cm-focused': { outline: 'none' },
        '.cm-navigation-target': { backgroundColor: 'var(--navigation-target)' },
        '.cm-navigation-symbol': { outline: '1px solid var(--accent)', borderRadius: '2px' },
        '.cm-blame-gutter .cm-gutterElement': {
          color: 'var(--muted)',
          paddingRight: '10px',
          whiteSpace: 'nowrap',
        },
      },
      { dark },
    ),
  ];
}
interface Props extends SemanticCallbacks {
  document: OpenEditor;
  dark: boolean;
  shortcuts?: Shortcuts;
  readOnly?: boolean;
  /** Keep a live diff visible while editing the working file. */
  diffBase?: string;
  breakpoints?: number[];
  coverage?: { line: number; count: number }[];
  executionLine?: number | null;
  onBreakpoints?(lines: number[], edited?: boolean): void;
  /** Git blame annotations shown in the gutter; null hides them. */
  blame?: BlameLine[] | null;
  /** Pin enclosing function headers while scrolling their bodies. */
  stickyLines?: boolean;
  onContextMenu?(x: number, y: number, view: EditorView): void;
  /** Copy `path:line` for the caret line (1-based). */
  onCopyReference?(line: number): void;
  onNavigate(operation: NavigationOperation | 'smart', position: Position): void;
  onPosition(position: Position): void;
  onFocus(): void;
  onSave(): void;
}
export function CodeEditor(props: Props) {
  const container = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const color = useRef(new Compartment());
  const syntax = useRef(new Compartment());
  const commandKeys = useRef(new Compartment());
  const editing = useRef(new Compartment());
  const sticky = useRef(new Compartment());
  const comparison = useRef(new Compartment());
  function editorKeys() {
    const shortcuts = callbacks.current.shortcuts ?? defaultShortcuts;
    return keymap.of(
      [
        {
          key: shortcuts.breakpoint,
          run: (view: EditorView) => {
            const line = view.state.doc.lineAt(view.state.selection.main.head).number - 1;
            const lines = callbacks.current.breakpoints ?? [];
            callbacks.current.onBreakpoints?.(
              lines.includes(line) ? lines.filter((item) => item !== line) : [...lines, line],
            );
            return true;
          },
        },
        {
          key: shortcuts.save,
          run: () => {
            callbacks.current.onSave();
            return true;
          },
        },
        {
          key: shortcuts.declaration,
          run: (view: EditorView) => {
            callbacks.current.onNavigate(
              'smart',
              positionAt(view.state, view.state.selection.main.head),
            );
            return true;
          },
        },
        {
          key: shortcuts.implementations,
          run: (view: EditorView) => {
            callbacks.current.onNavigate(
              'implementations',
              positionAt(view.state, view.state.selection.main.head),
            );
            return true;
          },
        },
        {
          key: shortcuts.usages,
          run: (view: EditorView) => {
            callbacks.current.onNavigate(
              'references',
              positionAt(view.state, view.state.selection.main.head),
            );
            return true;
          },
        },
        {
          key: shortcuts.format,
          run: () => {
            callbacks.current.onAction?.('format');
            return true;
          },
        },
        {
          key: shortcuts.rename,
          run: () => {
            callbacks.current.onAction?.('rename');
            return true;
          },
        },
        {
          key: shortcuts.copyReference,
          run: (view: EditorView) => {
            if (!callbacks.current.onCopyReference) return false;
            callbacks.current.onCopyReference(
              view.state.doc.lineAt(view.state.selection.main.head).number,
            );
            return true;
          },
        },
        {
          key: shortcuts.fixes,
          run: () => {
            callbacks.current.onAction?.('codeActions');
            return true;
          },
        },
      ].filter((binding) => !!binding.key),
    );
  }
  useEffect(() => {
    const doc = props.document;
    if (!container.current) return;
    const extensions = [
      editing.current.of([
        EditorState.readOnly.of(!!props.readOnly || !!doc.editingLocked),
        EditorView.editable.of(!props.readOnly && !doc.editingLocked),
      ]),
      EditorState.transactionFilter.of((transaction) =>
        doc.editingLocked &&
        transaction.docChanged &&
        !transaction.annotation(externalDocumentChange) &&
        !transaction.annotation(mirrored)
          ? []
          : transaction,
      ),
      ...debugGutters((line) => {
        const lines = callbacks.current.breakpoints ?? [];
        callbacks.current.onBreakpoints?.(
          lines.includes(line) ? lines.filter((item) => item !== line) : [...lines, line],
        );
      }),
      blameGutter(),
      comparison.current.of(
        props.diffBase === undefined
          ? []
          : unifiedMergeView({ original: props.diffBase, mergeControls: false }),
      ),
      lineNumbers(),
      highlightSpecialChars(),
      sticky.current.of(callbacks.current.stickyLines ? stickyLines() : []),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      highlightSelectionMatches(),
      navigationHighlight,
      syntax.current.of([]),
      color.current.of(theme(callbacks.current.dark)),
      ...semanticExtensions(doc, () => callbacks.current),
      commandKeys.current.of(editorKeys()),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        indentWithTab,
      ]),
      EditorView.domEventHandlers({
        focus: () => {
          callbacks.current.onFocus();
        },
        contextmenu: (event, view) => {
          if (!callbacks.current.onContextMenu) return false;
          event.preventDefault();
          // Like IntelliJ, a right-click outside the selection moves the caret there first.
          const offset = view.posAtCoords({ x: event.clientX, y: event.clientY });
          const { from, to } = view.state.selection.main;
          if (offset !== null && (offset < from || offset > to))
            view.dispatch({ selection: { anchor: offset } });
          view.focus();
          callbacks.current.onContextMenu(event.clientX, event.clientY, view);
          return true;
        },
        mousedown: (event, view) => {
          if (!event.metaKey || event.button !== 0) return false;
          const offset = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (offset === null) return false;
          event.preventDefault();
          callbacks.current.onNavigate('smart', positionAt(view.state, offset));
          return true;
        },
      }),
      EditorView.updateListener.of((update) => {
        doc.state = update.state;
        if (update.docChanged) for (const listener of doc.changeListeners) listener();
        if (
          update.docChanged &&
          !update.transactions.some(
            (transaction) =>
              transaction.annotation(mirrored) || transaction.annotation(externalDocumentChange),
          )
        ) {
          const deltas: TextDelta[] = [];
          update.changes.iterChanges((from, to, _newFrom, _newTo, insert) =>
            deltas.push({ from, to, insert: insert.toString() }),
          );
          doc.session.enqueue(deltas);
          for (const other of doc.views)
            if (other !== update.view)
              other.dispatch({ changes: update.changes, annotations: mirrored.of(true) });
        }
        if (
          update.docChanged &&
          !update.transactions.some((transaction) => transaction.annotation(mirrored))
        ) {
          const lines = breakpointLines(update.view);
          const previous = callbacks.current.breakpoints ?? [];
          if (
            callbacks.current.coverage?.length ||
            lines.length !== previous.length ||
            lines.some((line, index) => line !== previous[index])
          )
            callbacks.current.onBreakpoints?.(lines, true);
        }
        if ((update.selectionSet || update.docChanged) && update.view.hasFocus)
          callbacks.current.onPosition(positionAt(update.state, update.state.selection.main.head));
      }),
      EditorView.contentAttributes.of({
        'aria-label': `Editor for ${doc.session.path.split('/').pop()}`,
        spellcheck: 'false',
      }),
    ];
    // Preserve the document and undo history between tabs, rebind view callbacks on remount.
    const state = doc.state
      ? doc.state.update({ effects: StateReconfigure.of(extensions) }).state
      : EditorState.create({ doc: doc.initial, extensions });
    const view = new EditorView({ state, parent: container.current });
    viewRef.current = view;
    // ⌘/Ctrl + scroll and trackpad pinch (a ctrlKey wheel) zoom the code font, not the page.
    const zoomCode = (event: WheelEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      setEditorFontSize(editorFontSizeAfterWheel(currentEditorFontSize(), event.deltaY));
      for (const other of document.querySelectorAll('.cm-editor'))
        EditorView.findFromDOM(other as HTMLElement)?.requestMeasure();
    };
    view.dom.addEventListener('wheel', zoomCode, { passive: false });
    doc.initial = '';
    let alive = true;
    let syntaxRequest = 0;
    const loadSyntax = () => {
      const current = ++syntaxRequest;
      void syntaxFor(doc.session.path)
        .then((extension) => {
          if (alive && current === syntaxRequest)
            view.dispatch({ effects: syntax.current.reconfigure(extension) });
        })
        .catch(() => {
          if (alive && current === syntaxRequest)
            view.dispatch({ effects: syntax.current.reconfigure([]) });
        });
    };
    loadSyntax();
    const stopObservingSyntax = observeSyntaxChanges(loadSyntax);
    doc.views.add(view);
    view.focus();
    callbacks.current.onPosition(positionAt(view.state, view.state.selection.main.head));
    if (doc.pendingPosition) {
      const anchor = offsetAt(view.state, doc.pendingPosition);
      if (doc.pendingHighlight)
        revealNavigationTarget(view, anchor, offsetAt(view.state, doc.pendingHighlight));
      else
        view.dispatch({
          selection: { anchor },
          effects: EditorView.scrollIntoView(anchor, { y: 'center' }),
        });
      doc.pendingPosition = undefined;
      doc.pendingHighlight = undefined;
    }
    return () => {
      alive = false;
      stopObservingSyntax();
      doc.state = view.state;
      doc.views.delete(view);
      view.dom.removeEventListener('wheel', zoomCode);
      view.destroy();
      viewRef.current = null;
    };
  }, [props.document]);
  useEffect(() => {
    const readOnly = !!props.readOnly || !!props.document.editingLocked;
    viewRef.current?.dispatch({
      effects: editing.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [props.document, props.document.editingLocked, props.readOnly]);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: commandKeys.current.reconfigure(editorKeys()) });
  }, [props.shortcuts]);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: color.current.reconfigure(theme(props.dark)) });
  }, [props.dark]);
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: sticky.current.reconfigure(props.stickyLines ? stickyLines() : []),
    });
  }, [props.stickyLines]);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setBlame.of(props.blame ?? null) });
  }, [props.document, props.blame]);
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: [
        setBreakpoints.of(props.breakpoints ?? []),
        setCoverage.of(props.coverage ?? []),
        setExecutionLine.of(props.executionLine ?? null),
      ],
    });
  }, [props.document, props.breakpoints, props.coverage, props.executionLine]);
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: comparison.current.reconfigure(
        props.diffBase === undefined
          ? []
          : unifiedMergeView({ original: props.diffBase, mergeControls: false }),
      ),
    });
  }, [props.document, props.diffBase]);
  return <div className="code-editor" ref={container} />;
}
// Reconfigure retains history state fields when extensions are retained by identity.
import { StateEffect } from '@codemirror/state';
const StateReconfigure = StateEffect.reconfigure;
