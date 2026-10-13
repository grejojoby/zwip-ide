import { useEffect, useRef, useState } from 'react';
import type { Connection, SqlColumn, SqlPage, SqlQueryPage, SqlTable } from '../../contracts';
import { asError } from '../../model/document-session';
import { Modal } from '../Modal';
import { SqlConsole } from './SqlConsole';
import { toolRequest } from './tool-api';
import { cellText, parseCell } from './sql-values';
type Row = Record<string, unknown>;
export function SqlBrowser({
  connection,
  onDirty,
}: {
  connection: Connection;
  onDirty(dirty: boolean): void;
}) {
  const [tables, setTables] = useState<SqlTable[]>([]);
  const [table, setTable] = useState<SqlTable | null>(null);
  const [columns, setColumns] = useState<Record<string, SqlColumn[]>>({});
  const [page, setPage] = useState<SqlPage | null>(null);
  const [queryPage, setQueryPage] = useState<SqlQueryPage | null>(null);
  const [mode, setMode] = useState<'table' | 'query'>('table');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState<Map<number, Row>>(new Map());
  const [cell, setCell] = useState<{ row: number; column: SqlColumn } | null>(null);
  const [review, setReview] = useState(false);
  const epoch = useRef(0);
  const requestId = useRef(0);
  const runningQuery = useRef<string | null>(null);
  const readSql = useRef<() => string>(() => '');
  const busyRef = useRef(false);
  busyRef.current = busy;
  const connectionId = connection.id;
  useEffect(() => {
    ++epoch.current;
    void loadSchema();
    return () => {
      ++epoch.current;
      if (runningQuery.current)
        void toolRequest('sql', 'cancel', { queryId: runningQuery.current }).catch(() => {});
      void toolRequest('sql', 'disconnect', { connectionId }).catch(() => {});
    };
  }, [connectionId]);
  useEffect(() => {
    onDirty(drafts.size > 0);
  }, [drafts.size, onDirty]);
  async function run<T>(operation: () => Promise<T>, apply: (value: T) => void) {
    const mounted = epoch.current;
    const id = ++requestId.current;
    setBusy(true);
    setError('');
    try {
      const value = await operation();
      if (epoch.current === mounted && id === requestId.current) apply(value);
    } catch (e) {
      if (epoch.current === mounted && id === requestId.current) setError(asError(e).message);
    } finally {
      if (epoch.current === mounted && id === requestId.current) setBusy(false);
    }
  }
  async function loadSchema() {
    await run(() => toolRequest<SqlTable[]>('sql', 'schema', { connectionId }), setTables);
  }
  async function browse(next: SqlTable, offset = 0) {
    if (drafts.size) return;
    setMode('table');
    await run(
      () =>
        toolRequest<SqlPage>('sql', 'browse', {
          connectionId,
          schema: next.schema,
          table: next.name,
          offset,
          limit: 100,
        }),
      (result) => {
        setTable(next);
        setPage(result);
        setColumns((current) => ({ ...current, [`${next.schema}.${next.name}`]: result.columns }));
        setDrafts(new Map());
      },
    );
  }
  async function execute() {
    if (busyRef.current) return;
    const sql = readSql.current().trim();
    if (!sql) {
      setError('Enter a SQL query or select a statement to execute.');
      return;
    }
    setMode('query');
    const mounted = epoch.current;
    const old = runningQuery.current;
    const queryId = crypto.randomUUID();
    runningQuery.current = queryId;
    await run(
      async () => {
        if (old) await toolRequest('sql', 'cancel', { queryId: old });
        if (epoch.current !== mounted) throw new Error('SQL console closed.');
        return toolRequest<SqlQueryPage>('sql', 'query', {
          connectionId,
          queryId,
          sql,
          limit: 100,
        });
      },
      (result) => {
        setQueryPage(result);
        if (result.done) {
          runningQuery.current = null;
          void toolRequest('sql', 'cancel', { queryId }).catch(() => {});
        }
      },
    );
  }
  async function nextQuery() {
    const queryId = runningQuery.current;
    if (!queryId) return;
    await run(
      () => toolRequest<SqlQueryPage>('sql', 'next', { queryId }),
      (result) => {
        setQueryPage(result);
        if (result.done) {
          runningQuery.current = null;
          void toolRequest('sql', 'cancel', { queryId }).catch(() => {});
        }
      },
    );
  }
  async function cancelQuery() {
    const queryId = runningQuery.current;
    if (!queryId) return;
    try {
      await toolRequest('sql', 'cancel', { queryId });
      runningQuery.current = null;
      setQueryPage((current) => (current ? { ...current, done: true } : null));
    } catch (e) {
      setError(asError(e).message);
    }
  }
  async function apply() {
    if (!page || !table || !drafts.size) return;
    const edits = [...drafts].map(([index, after]) => ({ before: page.rows[index], after }));
    await run(
      async () => {
        await toolRequest('sql', 'applyEdits', {
          connectionId,
          schema: table.schema,
          table: table.name,
          changes: edits,
        });
        return true;
      },
      () => {
        setPage((current) =>
          current
            ? { ...current, rows: current.rows.map((row, index) => drafts.get(index) ?? row) }
            : current,
        );
        setDrafts(new Map());
        setReview(false);
      },
    );
  }
  const rows = mode === 'query' ? queryPage?.rows : page?.rows;
  const names = mode === 'query' ? queryPage?.columns : page?.columns.map((column) => column.name);
  return (
    <section className="sql-browser" aria-label="SQL database">
      <div className="sql-table-picker">
        <input
          aria-label="Filter database tables"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter tables…"
        />
        <select
          aria-label="Database table"
          disabled={busy || drafts.size > 0}
          value={table ? `${table.schema}.${table.name}` : ''}
          onChange={(e) => {
            const selected = tables.find(
              (item) => `${item.schema}.${item.name}` === e.target.value,
            );
            if (selected) void browse(selected);
          }}
        >
          <option value="">Choose a table…</option>
          {tables
            .filter((item) =>
              `${item.schema}.${item.name}`.toLowerCase().includes(filter.toLowerCase()),
            )
            .map((item) => (
              <option key={`${item.schema}.${item.name}`} value={`${item.schema}.${item.name}`}>
                {item.schema ? `${item.schema}.` : ''}
                {item.name}
                {item.type === 'view' ? ' (view)' : ''}
              </option>
            ))}
        </select>
        <button disabled={busy || drafts.size > 0} onClick={() => void loadSchema()}>
          Refresh schema
        </button>
      </div>
      <details className="sql-query-box" open>
        <summary>
          SQL console <span>⌘Enter executes selection or query</span>
        </summary>
        <SqlConsole
          kind={connection.kind}
          tables={tables}
          columns={columns}
          onRead={(read) => {
            readSql.current = read;
          }}
          onExecute={() => void execute()}
        />
        <div className="tool-section-title">
          <button className="primary" disabled={busy} onClick={() => void execute()}>
            Execute
          </button>
          <button disabled={!runningQuery.current} onClick={() => void cancelQuery()}>
            Cancel / close query
          </button>
          <span>{busy ? 'Working…' : 'Results are paged'}</span>
        </div>
      </details>
      {error && (
        <p className="inline-notice error-message" role="alert">
          {error}
        </p>
      )}
      <div className="response-tabs">
        <button disabled={!page} aria-pressed={mode === 'table'} onClick={() => setMode('table')}>
          Table data{drafts.size ? ` · ${drafts.size} edited` : ''}
        </button>
        <button
          disabled={!queryPage}
          aria-pressed={mode === 'query'}
          onClick={() => setMode('query')}
        >
          Query result
        </button>
        {mode === 'table' && page && (
          <span>
            {page.editable
              ? `Key: ${page.primaryKey.join(', ')}`
              : 'Read only · reliable editable row identity required'}
          </span>
        )}
      </div>
      <div className="data-grid-wrap">
        {rows && names ? (
          <table className="data-grid">
            <thead>
              <tr>
                <th scope="col">#</th>
                {names.map((name) => (
                  <th
                    key={name}
                    scope="col"
                    title={page?.columns.find((column) => column.name === name)?.type}
                  >
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr
                  key={index}
                  className={mode === 'table' && drafts.has(index) ? 'row-edited' : ''}
                >
                  <th scope="row">{index + 1 + (mode === 'table' ? (page?.offset ?? 0) : 0)}</th>
                  {names.map((name) => {
                    const value = mode === 'table' ? (drafts.get(index) ?? row)[name] : row[name];
                    const metadata =
                      mode === 'table'
                        ? page?.columns.find((column) => column.name === name)
                        : undefined;
                    const editable = !!page?.editable && mode === 'table' && metadata && !busy;
                    return (
                      <td
                        key={name}
                        title={cellText(value)}
                        className={value === null ? 'null-cell' : ''}
                      >
                        {editable ? (
                          <button
                            aria-label={`Edit row ${index + 1} ${name}`}
                            onClick={() => setCell({ row: index, column: metadata })}
                          >
                            {cellText(value).slice(0, 1000) || '\u00a0'}
                          </button>
                        ) : (
                          cellText(value).slice(0, 1000)
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="empty-note">Choose a table or execute a SQL statement.</p>
        )}
        {rows?.length === 0 && (
          <p className="empty-note">
            {mode === 'query' && queryPage?.affectedRows !== undefined
              ? `${queryPage.affectedRows} rows affected.`
              : 'No rows returned.'}
          </p>
        )}
      </div>
      {mode === 'table' && page && (
        <>
          <div className="tool-section-title">
            <span>
              {page.offset + (page.rows.length ? 1 : 0)}–{page.offset + page.rows.length}
            </span>
            <button
              disabled={busy || !!drafts.size || page.offset === 0}
              onClick={() => table && void browse(table, Math.max(0, page.offset - 100))}
            >
              Previous
            </button>
            <button
              disabled={busy || !!drafts.size || !page.hasMore}
              onClick={() => table && void browse(table, page.offset + 100)}
            >
              Next
            </button>
            <button
              disabled={busy || !!drafts.size}
              onClick={() => table && void browse(table, page.offset)}
            >
              Refresh data
            </button>
          </div>
          {drafts.size > 0 && (
            <div className="tool-section-title">
              <strong>{drafts.size} row edits pending</strong>
              <button disabled={busy} onClick={() => setDrafts(new Map())}>
                Discard edits
              </button>
              <button className="primary" disabled={busy} onClick={() => setReview(true)}>
                Review and apply…
              </button>
            </div>
          )}
          {page.truncated && (
            <p className="inline-notice">
              Some values or fields were omitted from this preview. These rows are read only.
            </p>
          )}
        </>
      )}
      {mode === 'query' && queryPage && (
        <div className="tool-section-title">
          <span>
            {queryPage.rows.length} rows · {queryPage.done ? 'Complete' : 'More rows available'}
            {queryPage.truncated ? ' · preview truncated; some values or fields omitted' : ''}
          </span>
          <button
            disabled={busy || queryPage.done || !runningQuery.current}
            onClick={() => void nextQuery()}
          >
            Next result page
          </button>
        </div>
      )}
      {cell && page && (
        <CellDialog
          column={cell.column}
          value={(drafts.get(cell.row) ?? page.rows[cell.row])[cell.column.name]}
          onClose={() => setCell(null)}
          onSave={(value) => {
            setDrafts((current) => {
              const next = new Map(current);
              const row = {
                ...(next.get(cell.row) ?? page.rows[cell.row]),
                [cell.column.name]: value,
              };
              if (JSON.stringify(row) === JSON.stringify(page.rows[cell.row]))
                next.delete(cell.row);
              else next.set(cell.row, row);
              return next;
            });
            setCell(null);
          }}
        />
      )}
      {review && page && (
        <Modal
          title="Apply database row edits"
          onClose={() => {
            if (!busy) setReview(false);
          }}
          wide
        >
          <div className="modal-body sql-edit-review">
            <p>
              Apply {drafts.size} row changes to {table?.schema ? `${table.schema}.` : ''}
              {table?.name}. All changes run in a transaction and reject rows changed since loading.
            </p>
            {[...drafts].map(([index, after]) => (
              <div key={index}>
                <strong>Row {page.offset + index + 1}</strong>
                <div className="sql-row-diff">
                  <pre>{JSON.stringify(page.rows[index], null, 2)}</pre>
                  <pre>{JSON.stringify(after, null, 2)}</pre>
                </div>
              </div>
            ))}
            {error && (
              <p role="alert" className="error-message">
                {error}
              </p>
            )}
          </div>
          <div className="modal-actions">
            <button disabled={busy} onClick={() => setReview(false)}>
              Keep editing
            </button>
            <button className="primary" disabled={busy} onClick={() => void apply()}>
              {busy ? 'Applying…' : 'Apply changes'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
function CellDialog({
  value,
  column,
  onSave,
  onClose,
}: {
  value: unknown;
  column: SqlColumn;
  onSave(value: unknown): void;
  onClose(): void;
}) {
  const [text, setText] = useState(value === null ? '' : cellText(value));
  const [isNull, setIsNull] = useState(value === null);
  const [error, setError] = useState('');
  return (
    <Modal title={`Edit ${column.name}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          try {
            onSave(parseCell(text, value, column, isNull));
          } catch (e) {
            setError(asError(e).message);
          }
        }}
      >
        <div className="modal-body">
          <label className="field-label">
            {column.name} · {column.type}
            <textarea
              data-autofocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={isNull}
              spellCheck={false}
            />
          </label>
          {column.nullable && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={isNull}
                onChange={(e) => setIsNull(e.target.checked)}
              />
              NULL
            </label>
          )}
          <p className="muted">Changes stay local until you review and apply them.</p>
          {error && (
            <p role="alert" className="error-message">
              {error}
            </p>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary">Keep edit</button>
        </div>
      </form>
    </Modal>
  );
}
