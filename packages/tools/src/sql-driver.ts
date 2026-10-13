import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { object, string, type Params } from './transport';
import { resultPreview } from './result-preview';
export type Row = Record<string, unknown>;
export interface Config {
  kind: 'mysql' | 'postgres' | 'sqlite';
  id: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  path?: string;
  tls?: boolean;
}
export interface Result {
  rows: Row[];
  affected: number;
}
export interface Driver {
  kind: Config['kind'];
  query(sql: string, values?: unknown[]): Promise<Result>;
  close(): Promise<void>;
}
export function config(value: unknown): Config {
  const p = object(value);
  if (!['mysql', 'postgres', 'sqlite'].includes(string(p, 'kind')))
    throw new Error('Unsupported SQL driver.');
  return p as unknown as Config;
}
export function quote(name: string, kind: Config['kind']) {
  if (!name || name.includes('\0')) throw new Error('Invalid SQL identifier.');
  const q = kind === 'mysql' ? '`' : '"';
  return q + name.replaceAll(q, q + q) + q;
}
export function tableName(schema: string, table: string, kind: Config['kind']) {
  return (schema && kind !== 'sqlite' ? quote(schema, kind) + '.' : '') + quote(table, kind);
}
export function parameter(index: number, kind: Config['kind']) {
  return kind === 'postgres' ? `$${index}` : '?';
}
export function mysqlConfig(c: Config) {
  return {
    host: c.host ?? '127.0.0.1',
    port: c.port ?? 3306,
    user: c.username,
    password: c.password,
    database: c.database,
    ssl: c.tls ? { rejectUnauthorized: true } : undefined,
    connectTimeout: 10000,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    multipleStatements: false,
  };
}
export function pgConfig(c: Config) {
  return {
    host: c.host ?? '127.0.0.1',
    port: c.port ?? 5432,
    user: c.username,
    password: c.password,
    database: c.database,
    ssl: c.tls ? { rejectUnauthorized: true } : undefined,
    connectionTimeoutMillis: 10000,
    statement_timeout: 120000,
  };
}
export async function connect(c: Config): Promise<Driver> {
  if (c.kind === 'sqlite') {
    if (!c.path) throw new Error('SQLite database path is required.');
    const db = new DatabaseSync(c.path);
    db.exec('PRAGMA busy_timeout=5000');
    return {
      kind: c.kind,
      async query(sql, values = []) {
        const statement = db.prepare(sql);
        const input = values.map((v) =>
          typeof v === 'boolean' ? Number(v) : v,
        ) as SQLInputValue[];
        if (statement.columns().length) {
          const rows: Row[] = [];
          for (const row of statement.iterate(...input)) {
            rows.push(row);
            if (rows.length > 10000)
              throw new Error('Metadata exceeded 10,000 rows. Narrow the selection.');
          }
          return { rows, affected: 0 };
        }
        const result = statement.run(...input);
        return { rows: [], affected: Number(result.changes) };
      },
      async close() {
        db.close();
      },
    };
  }
  if (c.kind === 'postgres') {
    const client = new pg.Client(pgConfig(c));
    client.on('error', () => {});
    await client.connect();
    return {
      kind: c.kind,
      async query(sql, values = []) {
        const result = await client.query({
          text: sql,
          values,
          types: { getTypeParser: () => (value: string) => value },
        });
        return { rows: result.rows, affected: result.rowCount ?? 0 };
      },
      async close() {
        await client.end();
      },
    };
  }
  const connection = await mysql.createConnection(mysqlConfig(c));
  return {
    kind: c.kind,
    async query(sql, values = []) {
      const [rows] = await connection.query(sql, values);
      return Array.isArray(rows)
        ? { rows: rows as Row[], affected: 0 }
        : { rows: [], affected: (rows as mysql.ResultSetHeader).affectedRows };
    },
    async close() {
      await connection.end();
    },
  };
}
export interface Column {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
}
export async function columns(
  driver: Driver,
  c: Config,
  schema: string,
  table: string,
): Promise<Column[]> {
  let rows: Row[];
  if (c.kind === 'sqlite') {
    rows = (await driver.query(`PRAGMA table_info(${quote(table, c.kind)})`)).rows;
    return rows.map((r) => ({
      name: String(r.name),
      type: String(r.type),
      nullable: !r.notnull,
      primaryKey: Number(r.pk) > 0,
    }));
  }
  if (c.kind === 'mysql') {
    rows = (
      await driver.query(
        'SELECT COLUMN_NAME name, DATA_TYPE type, IS_NULLABLE nullable, COLUMN_KEY pk FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',
        [schema || c.database, table],
      )
    ).rows;
    return rows.map((r) => ({
      name: String(r.name),
      type: String(r.type),
      nullable: r.nullable === 'YES',
      primaryKey: r.pk === 'PRI',
    }));
  }
  rows = (
    await driver.query(
      `SELECT c.column_name name,c.data_type type,c.is_nullable nullable,EXISTS(SELECT 1 FROM information_schema.table_constraints t JOIN information_schema.key_column_usage k USING(constraint_catalog,constraint_schema,constraint_name) WHERE t.constraint_type='PRIMARY KEY' AND t.table_schema=c.table_schema AND t.table_name=c.table_name AND k.column_name=c.column_name) pk FROM information_schema.columns c WHERE c.table_schema=$1 AND c.table_name=$2 ORDER BY c.ordinal_position`,
      [schema || 'public', table],
    )
  ).rows;
  return rows.map((r) => ({
    name: String(r.name),
    type: String(r.type),
    nullable: r.nullable === 'YES',
    primaryKey: r.pk === true || r.pk === 't',
  }));
}
export function safeRows(rows: Row[]) {
  const page = new RowPage(Math.max(1, rows.length));
  for (const row of rows) page.add(row);
  return page.result();
}

export function queryColumns(names: string[]): string[] {
  if (new Set(names).size !== names.length)
    throw new Error('Query result contains duplicate column names. Use unique column aliases.');
  return names;
}

/** Retain only bounded previews as a cursor yields rows, never an entire page
 * of raw large cells. A truncated page is read-only in the renderer. */
export class RowPage {
  private rows: Row[] = [];
  private truncated = false;
  private rowBudget: number;
  constructor(private maxRows = 500) {
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 500)
      throw new Error('A result page must contain between 1 and 500 rows.');
    this.rowBudget = Math.floor((4 * 1024 * 1024 - 2) / maxRows) - 1;
  }
  add(row: Row) {
    if (this.rows.length >= this.maxRows) throw new Error('Result page row limit exceeded.');
    // Reserve a share for every requested row. A large early value may lose
    // fields, but cannot consume the page and silently discard later rows.
    const preview = resultPreview(row, { bytes: this.rowBudget, nodes: 8192 });
    this.truncated ||= preview.truncated;
    this.rows.push((preview.value ?? {}) as Row);
  }
  result() {
    return { rows: this.rows, truncated: this.truncated };
  }
}
export const integer = (p: Params, key: string, fallback: number, max: number) => {
  const n = p[key] === undefined ? fallback : Number(p[key]);
  if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new Error(`Invalid ${key}.`);
  return n;
};
