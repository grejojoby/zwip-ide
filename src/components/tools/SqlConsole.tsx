import { useEffect, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { sql, PostgreSQL, MySQL, SQLite } from '@codemirror/lang-sql';
import { syntaxColors } from '../../editor/syntax-colors';
import type { Connection, SqlColumn, SqlTable } from '../../contracts';
export function SqlConsole({
  kind,
  tables,
  columns,
  onExecute,
  onRead,
}: {
  kind: Connection['kind'];
  tables: SqlTable[];
  columns: Record<string, SqlColumn[]>;
  onExecute(): void;
  onRead(read: () => string): void;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  const colors = useRef(new Compartment());
  const callbacks = useRef({ onExecute, onRead });
  callbacks.current = { onExecute, onRead };
  useEffect(() => {
    if (!parent.current) return;
    const editor = new EditorView({
      parent: parent.current,
      state: EditorState.create({
        extensions: [
          lineNumbers(),
          history(),
          autocompletion(),
          language.current.of([]),
          colors.current.of(syntaxColors(document.documentElement.dataset.theme === 'dark')),
          keymap.of([
            {
              key: 'Mod-Enter',
              run: () => {
                callbacks.current.onExecute();
                return true;
              },
            },
            ...completionKeymap,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.contentAttributes.of({ 'aria-label': 'SQL query', spellcheck: 'false' }),
          EditorView.theme({
            '&': {
              height: '100%',
              fontSize: '12px',
              background: 'var(--editor)',
              color: 'var(--text)',
            },
            '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--mono)' },
            '.cm-gutters': { background: 'var(--surface)', color: 'var(--muted)', border: 'none' },
            '.cm-content': { caretColor: 'var(--text)' },
          }),
        ],
      }),
    });
    view.current = editor;
    const themeObserver = new MutationObserver(() => {
      editor.dispatch({
        effects: colors.current.reconfigure(
          syntaxColors(document.documentElement.dataset.theme === 'dark'),
        ),
      });
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    callbacks.current.onRead(() => {
      const selected = editor.state.selection.main;
      return selected.empty
        ? editor.state.doc.toString()
        : editor.state.sliceDoc(selected.from, selected.to);
    });
    return () => {
      themeObserver.disconnect();
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
          dialect: kind === 'postgres' ? PostgreSQL : kind === 'mysql' ? MySQL : SQLite,
          schema,
          upperCaseKeywords: true,
        }),
      ),
    });
  }, [kind, tables, columns]);
  return <div className="sql-console-editor" ref={parent} />;
}
