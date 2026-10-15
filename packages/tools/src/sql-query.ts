import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import Cursor from 'pg-cursor';
import mysql from 'mysql2';
import { mssqlQuery } from './sql-mssql';
import type { Readable } from 'node:stream';
import { config, mysqlConfig, pgConfig, queryColumns, RowPage, type Row } from './sql-driver';
import { resultPreview } from './result-preview';
let next: (() => Promise<unknown>) | undefined;
let close: (() => void | Promise<void>) | undefined;
let busy = false;
process.on('message', async (message: unknown) => {
  const p = message as { id: number; method: string; config: unknown; sql: string; limit: number };
  if (p.method === 'cancel') {
    await close?.();
    process.exit();
  }
  if (busy) {
    process.send?.({ id: p.id, error: 'Query page already running.' });
    return;
  }
  busy = true;
  try {
    if (p.method === 'start') {
      const c = config(p.config);
      const limit = Math.min(500, Math.max(1, p.limit || 100));
      if (c.kind === 'sqlite') {
        const db = new DatabaseSync(c.path!);
        db.exec('PRAGMA busy_timeout=5000');
        const statement = db.prepare(p.sql);
        const columns = queryColumns(statement.columns().map((field) => field.name));
        close = () => db.close();
        if (!columns.length) {
          const result = statement.run();
          next = async () => ({
            rows: [],
            columns,
            done: true,
            affectedRows: Number(result.changes),
            truncated: false,
          });
        } else {
          const iterator = statement.iterate();
          next = async () => {
            const rows = new RowPage(limit);
            let done = false;
            for (let i = 0; i < limit; i++) {
              const item = iterator.next();
              if (item.done) {
                done = true;
                break;
              }
              rows.add(item.value);
            }
            return { ...rows.result(), columns, done };
          };
        }
      } else if (c.kind === 'mssql') {
        const query = await mssqlQuery(c, p.sql, limit);
        close = query.close;
        next = query.next;
      } else if (c.kind === 'postgres') {
        const client = new pg.Client(pgConfig(c));
        client.on('error', () => {});
        await client.connect();
        const backend = await client.query('SELECT pg_backend_pid() id');
        process.send?.({ backendId: Number(backend.rows[0].id) });
        let decodedColumns = 0;
        let decodedTruncated = false;
        const cursor = client.query(
          new Cursor<Row>(p.sql, [], {
            types: {
              getTypeParser: () => {
                decodedColumns++;
                return (value: string) => {
                  const preview = resultPreview(value, {
                    bytes: Math.max(4, Math.floor((4 * 1024 * 1024) / (limit * decodedColumns))),
                    nodes: 1,
                  });
                  decodedTruncated ||= preview.truncated;
                  return preview.value;
                };
              },
            },
          }),
        );
        close = () => client.end();
        next = () =>
          new Promise((resolve, reject) => {
            decodedTruncated = false;
            cursor.read(limit, (error, rows, result) => {
              if (error) reject(error);
              else {
                try {
                  const columns = queryColumns(result.fields.map((f) => f.name));
                  const page = new RowPage(limit);
                  for (const row of rows) page.add(row);
                  const preview = page.result();
                  resolve({
                    ...preview,
                    truncated: preview.truncated || decodedTruncated,
                    columns,
                    done: rows.length < limit,
                    affectedRows: result.rowCount ?? 0,
                  });
                } catch (error) {
                  reject(error);
                }
              }
            });
          });
      } else {
        const connection = mysql.createConnection(mysqlConfig(c));
        await new Promise<void>((resolve, reject) =>
          connection.connect((error) => (error ? reject(error) : resolve())),
        );
        process.send?.({ backendId: connection.threadId });
        const query = connection.query(p.sql);
        let columns: string[] = [];
        query.on('fields', (fields: unknown) => {
          if (Array.isArray(fields)) columns = fields.map((f: { name: string }) => f.name);
        });
        const stream: Readable = query.stream({ highWaterMark: 1 });
        const iterator = stream[Symbol.asyncIterator]();
        close = () => connection.destroy();
        next = async () => {
          const rows = new RowPage(limit);
          let done = false;
          let affectedRows = 0;
          for (let i = 0; i < limit; i++) {
            const item = await iterator.next();
            if (item.done) {
              done = true;
              break;
            }
            if (!columns.length && 'affectedRows' in item.value) {
              affectedRows = Number(item.value.affectedRows);
              done = true;
              break;
            }
            rows.add(item.value);
          }
          return { ...rows.result(), columns: queryColumns(columns), done, affectedRows };
        };
      }
    }
    if (!next) throw new Error('Start a query first.');
    const result = await next();
    process.send?.({ id: p.id, result });
  } catch (error) {
    process.send?.({ id: p.id, error: error instanceof Error ? error.message : String(error) });
  } finally {
    busy = false;
  }
});
process.on('disconnect', () => {
  void Promise.resolve(close?.()).finally(() => process.exit());
});
