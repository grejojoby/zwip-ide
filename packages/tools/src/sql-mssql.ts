import mssql from 'mssql';
import { Readable } from 'node:stream';
import type { Config, Driver, Row } from './sql-driver';
import { queryColumns, RowPage } from './sql-results';

export function mssqlConfig(c: Config): mssql.config {
  return {
    server: c.host ?? '127.0.0.1',
    port: c.port ?? 1433,
    database: c.database || undefined,
    user: c.username,
    password: c.password,
    connectionTimeout: 10000,
    requestTimeout: 120000,
    options: { encrypt: c.tls ?? true, trustServerCertificate: c.trustServerCertificate ?? false },
    pool: { min: 0, max: 1 },
  };
}
async function poolFor(c: Config) {
  const pool = new mssql.ConnectionPool(mssqlConfig(c));
  pool.on('error', () => {});
  try {
    return await pool.connect();
  } catch (error) {
    await pool.close();
    throw error;
  }
}
export async function connectMssql(c: Config): Promise<Driver> {
  const pool = await poolFor(c);
  let transaction: mssql.Transaction | undefined;
  return {
    kind: 'mssql',
    async query(text, values = []) {
      if (text === 'BEGIN') {
        transaction = new mssql.Transaction(pool);
        await transaction.begin();
        return { rows: [], affected: 0 };
      }
      if (text === 'COMMIT' || text === 'ROLLBACK') {
        if (!transaction) throw new Error('No SQL Server transaction is active.');
        if (text === 'COMMIT') await transaction.commit();
        else await transaction.rollback();
        transaction = undefined;
        return { rows: [], affected: 0 };
      }
      const request = transaction ? new mssql.Request(transaction) : pool.request();
      request.arrayRowMode = true;
      values.forEach((value, index) => request.input(`p${index + 1}`, value));
      // @types/mssql does not describe arrayRowMode's columns/row shape.
      const result = (await request.query(text)) as unknown as {
        columns?: { name: string }[][];
        recordset?: unknown[][];
        rowsAffected: number[];
      };
      const fields = result.columns?.[0] ?? [];
      const names = queryColumns(fields.map((field) => field.name));
      if ((result.recordset?.length ?? 0) > 10000)
        throw new Error('Metadata exceeded 10,000 rows. Narrow the selection.');
      const rows = (result.recordset ?? []).map((row) =>
        Object.fromEntries(names.map((name, index) => [name, row[index]])),
      );
      return { rows, affected: result.rowsAffected.reduce((sum, count) => sum + count, 0) };
    },
    async close() {
      try {
        if (transaction) await transaction.rollback();
      } finally {
        await pool.close();
      }
    },
  };
}

type Token =
  | { kind: 'columns'; names: string[] }
  | { kind: 'row'; values: unknown[] }
  | { kind: 'done'; affected: number };
/** Include recordset boundaries in the stream so procedure results with different
 * columns never get combined. Pause the driver when the consumer's page is full. */
export async function mssqlQuery(c: Config, text: string, limit: number) {
  const pool = await poolFor(c);
  const request = pool.request();
  request.stream = true;
  request.arrayRowMode = true;
  request.pause();
  const stream = new Readable({
    objectMode: true,
    highWaterMark: 1,
    read() {
      request.resume();
    },
  });
  const push = (token: Token) => {
    if (!stream.destroyed && !stream.push(token)) request.pause();
  };
  request.on('recordset', (fields: { name: string }[]) => {
    try {
      push({ kind: 'columns', names: queryColumns(fields.map((field) => field.name)) });
    } catch (error) {
      stream.destroy(error as Error);
      request.cancel();
    }
  });
  request.on('row', (values: unknown[]) => push({ kind: 'row', values }));
  request.on('error', (error: Error) => stream.destroy(error));
  request.on('done', (result: mssql.IResult<unknown[]>) => {
    push({ kind: 'done', affected: result.rowsAffected.reduce((sum, count) => sum + count, 0) });
    stream.push(null);
  });
  // Retain errors even if they arrive between page requests.
  stream.on('error', () => {});
  const iterator = stream[Symbol.asyncIterator]();
  let names: string[] = [];
  let resultSet = 0;
  let pendingColumns: string[] | undefined;
  let done = false;
  void request.query(text).catch((error: Error) => stream.destroy(error));
  return {
    async next() {
      if (done) throw new Error('Query is complete.');
      const page = new RowPage(limit);
      let count = 0;
      let affectedRows: number | undefined;
      let sawColumns = pendingColumns !== undefined;
      if (pendingColumns) {
        names = pendingColumns;
        resultSet++;
        pendingColumns = undefined;
      }
      while (count < limit) {
        const item = await iterator.next();
        if (item.done) {
          done = true;
          break;
        }
        const token = item.value as Token;
        if (token.kind === 'columns') {
          if (count > 0 || sawColumns) {
            pendingColumns = token.names;
            break;
          }
          names = token.names;
          resultSet++;
          sawColumns = true;
        } else if (token.kind === 'done') {
          done = true;
          affectedRows = token.affected;
          break;
        } else {
          page.add(
            Object.fromEntries(names.map((name, index) => [name, token.values[index]])) as Row,
          );
          count++;
        }
      }
      return { ...page.result(), columns: names, resultSet, done, affectedRows };
    },
    async close() {
      request.resume();
      request.cancel();
      stream.destroy();
      await pool.close();
    },
  };
}
