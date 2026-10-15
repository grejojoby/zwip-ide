import { useEffect, useRef } from 'react';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { sql, PostgreSQL, MySQL, SQLite, MSSQL } from '@codemirror/lang-sql';
import { syntaxColors } from '../../editor/syntax-colors';
import type { Connection, SqlColumn, SqlTable } from '../../contracts';
export function SqlConsole({
  kind,
  tables,
  columns,
  initialContent = '',
  onExecute,
  onRead,
  onChange,
}: {
  kind: Connection['kind'];
  tables: SqlTable[];
  columns: Record<string, SqlColumn[]>;
  initialContent?: string;
  onExecute(): void;
  onRead(read: () => string): void;
  onChange?(content: string): void;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  const initial = useRef(initialContent);
  const callbacks = useRef({ onExecute, onRead, onChange });
  callbacks.current = { onExecute, onRead, onChange };
  useEffect(() => {
    if (!parent.current) return;
    const editor = new EditorView({
      parent: parent.current,
      state: EditorState.create({
        doc: initial.current,
        extensions: [
          lineNumbers(),
          history(),
          autocompletion(),
          language.current.of([]),
          syntaxColors(),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange?.(update.state.doc.toString());
          }),
          Prec.highest(
            keymap.of(
              ['Meta-Enter', 'Ctrl-Enter'].map((key) => ({
                key,
                run: () => {
                  callbacks.current.onExecute();
                  return true;
                },
              })),
            ),
          ),
          keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap]),
          EditorView.contentAttributes.of({ 'aria-label': 'SQL query', spellcheck: 'false' }),
          EditorView.theme({
            '&': {
              height: '100%',
              fontSize: '12px',
              background: 'var(--editor)',
              color: 'var(--syntax-text)',
            },
            '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--mono)' },
            '.cm-gutters': { background: 'var(--surface)', color: 'var(--muted)', border: 'none' },
            '.cm-content': { caretColor: 'var(--text)' },
          }),
        ],
      }),
    });
    view.current = editor;
    callbacks.current.onRead(() => {
      const selected = editor.state.selection.main;
      return selected.empty
        ? editor.state.doc.toString()
        : editor.state.sliceDoc(selected.from, selected.to);
    });
    return () => {
      view.current = null;
      editor.destroy();
    };
  }, []);
  useEffect(() => {
    const schema: Record<string, string[]> = {};
    for (const table of tables) {
      const names = (columns[`${table.schema}.${table.name}`] ?? []).map((column) => column.name);
      schema[table.name] = names;
      if (table.schema) schema[`${table.schema}.${table.name}`] = names;
    }
    view.current?.dispatch({
      effects: language.current.reconfigure(
        sql({
          dialect:
            kind === 'mssql'
              ? MSSQL
              : kind === 'postgres'
                ? PostgreSQL
                : kind === 'mysql'
                  ? MySQL
                  : SQLite,
          schema,
          upperCaseKeywords: true,
        }),
      ),
    });
  }, [kind, tables, columns]);
  return <div className="sql-console-editor" ref={parent} />;
}
