import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { queryFixture } from './query-fixture';
import { createServer, type RequestListener } from 'node:http';
import { SqlService } from '../../packages/tools/src/sql';
import { HttpService, parseHttp } from '../../packages/tools/src/http';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
let worker: Awaited<ReturnType<typeof queryFixture>>;
beforeAll(async () => {
  worker = await queryFixture();
});
afterAll(() => worker?.dispose());
function database() {
  const directory = mkdtempSync(join(tmpdir(), 'zwip-sql-test-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'test.sqlite');
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT);INSERT INTO users VALUES(1,'one'),(2,'two');CREATE TABLE ambiguous(name TEXT);INSERT INTO ambiguous VALUES('x'),('x')",
  );
  db.close();
  const service = new SqlService(worker.path);
  cleanup.push(() => service.dispose());
  return { service, connection: { id: 'sqlite-test', kind: 'sqlite', path } };
}
async function httpServer(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  cleanup.push(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server address unavailable');
  return `http://127.0.0.1:${address.port}`;
}
describe('SQL package', () => {
  it('rejects duplicate SQLite result labels and accepts distinct aliases without corrupting values', async () => {
    const { service, connection } = database();
    await expect(
      service.dispatch('query', { connection, queryId: 'duplicate', sql: 'SELECT 1 id,2 id' }),
    ).rejects.toThrow('Use unique column aliases');
    expect(
      await service.dispatch('query', {
        connection,
        queryId: 'duplicate',
        sql: 'SELECT 1 first_id,2 second_id',
      }),
    ).toMatchObject({ rows: [{ first_id: 1, second_id: 2 }] });
  });
  it('returns an explicitly truncated bounded preview from real SQLite query rows', async () => {
    const { service, connection } = database();
    const result = (await service.dispatch('query', {
      connection,
      queryId: 'large-values',
      sql: 'WITH RECURSIVE c(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM c WHERE n<120) SELECT n,hex(zeroblob(262144)) value FROM c',
      limit: 100,
    })) as { rows: { n: number }[]; truncated: boolean; done: boolean };
    expect(result.truncated).toBe(true);
    expect(result.done).toBe(false);
    expect(result.rows.map((row) => row.n)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(Buffer.byteLength(JSON.stringify(result.rows))).toBeLessThanOrEqual(4 * 1024 * 1024);
    const next = (await service.dispatch('next', { queryId: 'large-values' })) as typeof result;
    expect(next.done).toBe(true);
    expect(next.rows.map((row) => row.n)).toEqual(Array.from({ length: 20 }, (_, i) => i + 101));
  });
  it('keeps truncated table previews read-only and preserves primary-key pagination', async () => {
    const { service, connection } = database();
    const db = new DatabaseSync(connection.path);
    db.exec(
      'CREATE TABLE large(id INTEGER PRIMARY KEY,payload TEXT);INSERT INTO large VALUES(1,hex(zeroblob(131072))),(2,hex(zeroblob(131072)))',
    );
    db.close();
    const first = (await service.dispatch('browse', { connection, table: 'large', limit: 1 })) as {
      rows: { id: number }[];
    };
    expect(first).toMatchObject({
      editable: false,
      truncated: true,
      primaryKey: ['id'],
      hasMore: true,
    });
    expect(first.rows[0].id).toBe(1);
    const next = await service.dispatch('browse', {
      connection,
      table: 'large',
      limit: 1,
      offset: 1,
    });
    expect(next).toMatchObject({
      editable: false,
      truncated: true,
      hasMore: false,
      rows: [{ id: 2 }],
    });
  });
  it('expires long queries and releases their query slot', async () => {
    const { connection } = database();
    // Include process startup in the deadline without turning this reliability
    // regression into a 200 ms scheduling benchmark on a busy development Mac.
    const service = new SqlService(worker.path, 2000);
    cleanup.push(() => service.dispose());
    await expect(
      service.dispatch('query', {
        connection,
        queryId: 'timeout',
        sql: 'WITH RECURSIVE c(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM c WHERE n<1000000000) SELECT sum(n) FROM c',
      }),
    ).rejects.toThrow('timed out');
    await expect(service.dispatch('next', { queryId: 'timeout' })).rejects.toThrow('closed');
    expect(
      await service.dispatch('query', { connection, queryId: 'timeout', sql: 'SELECT 1 AS value' }),
    ).toMatchObject({ rows: [{ value: 1 }] });
  });
  it('pages actual SQLite results and refuses ambiguous row identity', async () => {
    const { service, connection } = database();
    const first = (await service.dispatch('query', {
      connection,
      queryId: 'q',
      sql: 'SELECT * FROM users ORDER BY id',
      limit: 1,
    })) as { rows: unknown[]; done: boolean };
    expect(first.rows).toEqual([{ id: 1, name: 'one' }]);
    expect(first.done).toBe(false);
    expect(await service.dispatch('next', { queryId: 'q' })).toMatchObject({
      rows: [{ id: 2, name: 'two' }],
    });
    expect(await service.dispatch('browse', { connection, table: 'ambiguous' })).toMatchObject({
      editable: false,
    });
    await expect(
      service.dispatch('applyEdits', {
        connection,
        table: 'ambiguous',
        changes: [{ before: { name: 'x' }, after: { name: 'y' } }],
      }),
    ).rejects.toThrow('primary key');
  });
  it('rolls back every row when one original value is stale', async () => {
    const { service, connection } = database();
    await expect(
      service.dispatch('applyEdits', {
        connection,
        table: 'users',
        changes: [
          { before: { id: 1, name: 'one' }, after: { id: 1, name: 'changed' } },
          { before: { id: 2, name: 'stale' }, after: { id: 2, name: 'changed' } },
        ],
      }),
    ).rejects.toThrow('changed since');
    expect(await service.dispatch('browse', { connection, table: 'users' })).toMatchObject({
      rows: [
        { id: 1, name: 'one' },
        { id: 2, name: 'two' },
      ],
    });
    await service.dispatch('applyEdits', {
      connection,
      table: 'users',
      changes: [{ before: { id: 1, name: 'one' }, after: { id: 1, name: 'updated' } }],
    });
    expect(await service.dispatch('browse', { connection, table: 'users' })).toMatchObject({
      rows: [
        { id: 1, name: 'updated' },
        { id: 2, name: 'two' },
      ],
    });
  });
  it('cancels a long SQLite query by stopping only its owned process', async () => {
    const { service, connection } = database();
    const pending = service.dispatch('query', {
      connection,
      queryId: 'long',
      sql: 'WITH RECURSIVE c(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM c WHERE n<1000000000) SELECT sum(n) FROM c',
    });
    const rejection = expect(pending).rejects.toThrow(/canceled|exited/);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await service.dispatch('cancel', { queryId: 'long' });
    await rejection;
    expect(await service.dispatch('browse', { connection, table: 'users' })).toMatchObject({
      rows: [
        { id: 1, name: 'one' },
        { id: 2, name: 'two' },
      ],
    });
  });
});
describe('HTTP package', () => {
  it('substitutes explicit environments and rejects unresolved credentials', () => {
    expect(
      parseHttp('GET {{base}}/test\nAuthorization: Bearer {{token}}', {
        base: 'https://example.test',
        token: 'abc',
      }).headers.get('authorization'),
    ).toBe('Bearer abc');
    expect(() => parseHttp('GET https://example.test\nAuthorization: {{missing}}')).toThrow(
      'Missing HTTP environment',
    );
  });
  it('executes real requests and bounds large response bodies', async () => {
    const url = await httpServer((_request, response) => {
      response.setHeader('content-type', 'text/plain');
      response.end('x'.repeat(3 * 1024 * 1024));
    });
    const service = new HttpService();
    cleanup.push(() => service.dispose());
    const result = await service.execute({ id: 'large', source: `GET ${url}` });
    expect(result.status).toBe(200);
    expect(result.bytes).toBe(2 * 1024 * 1024);
    expect(result.truncated).toBe(true);
  });
  it('cancels requests without retaining active work', async () => {
    const url = await httpServer(() => {});
    const service = new HttpService();
    cleanup.push(() => service.dispose());
    const request = service.execute({ id: 'slow', source: `GET ${url}` });
    const rejection = expect(request).rejects.toThrow(/canceled/);
    await new Promise((resolve) => setTimeout(resolve, 30));
    service.cancel('slow');
    await rejection;
  });
});
