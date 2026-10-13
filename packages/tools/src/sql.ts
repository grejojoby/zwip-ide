import { fork, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  columns,
  config,
  connect,
  integer,
  parameter,
  quote,
  safeRows,
  tableName,
  type Config,
  type Driver,
  type Row,
} from './sql-driver';
import { object, string, type Params } from './transport';
type Query = {
  id: string;
  config: Config;
  backendId?: number;
  child: ChildProcess;
  connectionId: string;
  next: number;
  pending: Map<
    number,
    {
      resolve: (result: unknown) => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >;
};
export class SqlService {
  private queries = new Map<string, Query>();
  constructor(
    private queryWorker = join(dirname(fileURLToPath(import.meta.url)), 'sql-query.cjs'),
    private queryTimeoutMs = 120000,
  ) {}
  private async withDriver<T>(c: Config, operation: (driver: Driver) => Promise<T>) {
    const driver = await connect(c);
    try {
      return await operation(driver);
    } finally {
      await driver.close();
    }
  }
  private async page(query: Query, message: Params) {
    const id = query.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Stop the owned server query too: killing its socket does not interrupt
        // operations such as MySQL SLEEP until the server tries to send a reply.
        reject(new Error('Query timed out; connection closed.'));
        void this.cancel(query.id).catch(() => {});
      }, this.queryTimeoutMs);
      query.pending.set(id, { resolve, reject, timer });
      query.child.send({ ...message, id });
    });
  }
  async cancel(id: string) {
    const query = this.queries.get(id);
    if (query) {
      this.queries.delete(id);
      for (const pending of query.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Query canceled.'));
      }
      query.pending.clear();
      try {
        if (query.backendId && Number.isSafeInteger(query.backendId)) {
          await this.withDriver(query.config, async (driver) => {
            if (query.config.kind === 'postgres')
              await driver.query('SELECT pg_cancel_backend($1)', [query.backendId]);
            else if (query.config.kind === 'mysql')
              await driver.query(`KILL QUERY ${query.backendId}`);
          });
        }
      } finally {
        query.child.kill('SIGKILL');
      }
    }
    return null;
  }
  async dispatch(method: string, p: Params): Promise<unknown> {
    if (method === 'cancel') return this.cancel(string(p, 'queryId'));
    if (method === 'disconnect') {
      for (const [id, query] of this.queries) {
        if (query.connectionId === p.connectionId) await this.cancel(id);
      }
      return null;
    }
    if (method === 'next') {
      const query = this.queries.get(string(p, 'queryId'));
      if (!query) throw new Error('Query is closed.');
      return this.page(query, { method: 'next' });
    }
    const c = config(p.connection);
    const schema =
      typeof p.schema === 'string'
        ? p.schema
        : c.kind === 'postgres'
          ? 'public'
          : (c.database ?? '');
    if (method === 'query') {
      const id = string(p, 'queryId');
      if (this.queries.has(id)) throw new Error('Query id is already running.');
      if (this.queries.size >= 4)
        throw new Error('Close a query before starting another (maximum 4).');
      const child = fork(this.queryWorker, [], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        execArgv: [],
      });
      const query: Query = {
        id,
        config: c,
        child,
        connectionId: c.id,
        next: 1,
        pending: new Map(),
      };
      this.queries.set(id, query);
      child.on('message', (message: unknown) => {
        const reply = message as {
          id: number;
          backendId?: number;
          result?: unknown;
          error?: string;
        };
        if (reply.backendId) {
          query.backendId = reply.backendId;
          return;
        }
        const pending = query.pending.get(reply.id);
        if (pending) {
          clearTimeout(pending.timer);
          query.pending.delete(reply.id);
          if (reply.error) pending.reject(new Error(reply.error));
          else pending.resolve(reply.result);
        }
      });
      child.on('exit', () => {
        for (const pending of query.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Query process exited.'));
        }
        query.pending.clear();
        if (this.queries.get(id) === query) this.queries.delete(id);
      });
      child.on('error', (error) => {
        for (const pending of query.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        query.pending.clear();
        if (this.queries.get(id) === query) this.queries.delete(id);
      });
      try {
        return {
          queryId: id,
          ...object(
            await this.page(query, {
              method: 'start',
              config: c,
              sql: string(p, 'sql'),
              limit: integer(p, 'limit', 100, 500),
            }),
          ),
        };
      } catch (error) {
        await this.cancel(id);
        throw error;
      }
    }
    return this.withDriver(c, async (driver) => {
      if (method === 'schema') {
        let rows: Row[];
        if (c.kind === 'sqlite')
          rows = (
            await driver.query(
              "SELECT '' schema,name,type FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
          ).rows;
        else if (c.kind === 'mysql')
          rows = (
            await driver.query(
              'SELECT TABLE_SCHEMA AS `schema`, TABLE_NAME name, TABLE_TYPE type FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME',
              [c.database],
            )
          ).rows;
        else
          rows = (
            await driver.query(
              "SELECT table_schema schema,table_name name,table_type type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema,table_name",
            )
          ).rows;
        return rows.map((row) => ({
          schema: row.schema,
          name: row.name,
          type: String(row.type).toLowerCase().includes('view') ? 'view' : 'table',
        }));
      }
      const table = string(p, 'table');
      const metadata = await columns(driver, c, schema, table);
      if (!metadata.length) throw new Error('Table was not found or has no visible columns.');
      if (method === 'columns') return metadata;
      if (method === 'browse') {
        const limit = integer(p, 'limit', 100, 500),
          offset = integer(p, 'offset', 0, 10000000);
        const pk = metadata.filter((col) => col.primaryKey).map((col) => col.name);
        const rows = (
          await driver.query(
            `SELECT * FROM ${tableName(schema, table, c.kind)}${pk.length ? ' ORDER BY ' + pk.map((name) => quote(name, c.kind)).join(',') : ''} LIMIT ${limit + 1} OFFSET ${offset}`,
          )
        ).rows;
        const result = safeRows(rows.slice(0, limit));
        const editable =
          pk.length > 0 &&
          !result.truncated &&
          result.rows.every((row) =>
            Object.values(row).every(
              (value) => value === null || ['string', 'number', 'boolean'].includes(typeof value),
            ),
          );
        return {
          ...result,
          columns: metadata,
          primaryKey: pk,
          editable,
          hasMore: rows.length > limit,
          offset,
        };
      }
      if (method === 'applyEdits') {
        const changes = p.changes;
        if (!Array.isArray(changes) || !changes.length || changes.length > 100)
          throw new Error('Apply between 1 and 100 row changes.');
        const pk = metadata.filter((col) => col.primaryKey);
        if (!pk.length) throw new Error('Row editing requires a primary key.');
        await driver.query('BEGIN');
        try {
          for (const raw of changes) {
            const change = object(raw);
            const before = object(change.before),
              after = object(change.after);
            const names = metadata.map((col) => col.name);
            if (
              names.some((name) => !(name in before)) ||
              Object.keys(after).some((name) => !names.includes(name)) ||
              pk.some((col) => before[col.name] === null)
            )
              throw new Error('Row identity or original values are incomplete.');
            const changed = names.filter(
              (name) =>
                name in after && JSON.stringify(before[name]) !== JSON.stringify(after[name]),
            );
            if (!changed.length) continue;
            const values: unknown[] = [];
            const bind = (value: unknown) => {
              values.push(value);
              return parameter(values.length, c.kind);
            };
            const assignments = changed.map(
              (name) => `${quote(name, c.kind)}=${bind(after[name])}`,
            );
            const where = names.map(
              (name) =>
                `${quote(name, c.kind)} ${c.kind === 'postgres' ? 'IS NOT DISTINCT FROM' : c.kind === 'mysql' ? '<=>' : 'IS'} ${bind(before[name])}`,
            );
            const result = await driver.query(
              `UPDATE ${tableName(schema, table, c.kind)} SET ${assignments.join(',')} WHERE ${where.join(' AND ')}`,
              values,
            );
            if (result.affected !== 1)
              throw new Error('Row changed since it was loaded; no row edits were applied.');
          }
          await driver.query('COMMIT');
          return { applied: true };
        } catch (error) {
          await driver.query('ROLLBACK');
          throw error;
        }
      }
      throw new Error('Unsupported SQL operation.');
    });
  }
  async dispose() {
    await Promise.allSettled([...this.queries.keys()].map((id) => this.cancel(id)));
  }
}
