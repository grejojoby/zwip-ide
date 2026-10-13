import { queryFixture } from './query-fixture';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import { SqlService } from '../../packages/tools/src/sql';
const port = Number(process.env.ZWIP_TEST_MYSQL_PORT);
describe.skipIf(!port)('disposable MySQL server', () => {
  const config = {
    id: 'mysql-test',
    kind: 'mysql',
    host: '127.0.0.1',
    port,
    username: 'root',
    database: 'zwip_test',
  };
  let service: SqlService;
  let queryWorker: Awaited<ReturnType<typeof queryFixture>>;
  beforeAll(async () => {
    queryWorker = await queryFixture();
    service = new SqlService(queryWorker.path);
    let last: unknown;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const db = await mysql.createConnection({
          host: '127.0.0.1',
          port,
          user: 'root',
          database: 'zwip_test',
        });
        await db.query('CREATE TABLE zwip_fixture(id INT PRIMARY KEY,name VARCHAR(100))');
        await db.query("INSERT INTO zwip_fixture VALUES(1,'one'),(2,'two')");
        await db.end();
        return;
      } catch (error) {
        last = error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw last;
  }, 35000);
  afterAll(async () => {
    await service?.dispose();
    queryWorker?.dispose();
    const db = await mysql.createConnection({
      host: '127.0.0.1',
      port,
      user: 'root',
      database: 'zwip_test',
    });
    await db.query('DROP TABLE IF EXISTS zwip_fixture');
    await db.end();
  });
  it('discovers and pages rows through the actual server driver', async () => {
    expect(await service.dispatch('schema', { connection: config })).toContainEqual({
      schema: 'zwip_test',
      name: 'zwip_fixture',
      type: 'table',
    });
    expect(
      await service.dispatch('query', {
        connection: config,
        queryId: 'mysql-query',
        sql: 'SELECT * FROM zwip_fixture ORDER BY id',
        limit: 1,
      }),
    ).toMatchObject({ rows: [{ id: 1, name: 'one' }], done: false });
    expect(await service.dispatch('next', { queryId: 'mysql-query' })).toMatchObject({
      rows: [{ id: 2, name: 'two' }],
    });
    await service.cancel('mysql-query');
  });
  it('requires original row values and commits explicit edits', async () => {
    expect(
      await service.dispatch('browse', { connection: config, table: 'zwip_fixture' }),
    ).toMatchObject({ editable: true, primaryKey: ['id'] });
    await expect(
      service.dispatch('applyEdits', {
        connection: config,
        table: 'zwip_fixture',
        changes: [{ before: { id: 1, name: 'stale' }, after: { id: 1, name: 'changed' } }],
      }),
    ).rejects.toThrow('changed since');
    await service.dispatch('applyEdits', {
      connection: config,
      table: 'zwip_fixture',
      changes: [{ before: { id: 1, name: 'one' }, after: { id: 1, name: 'updated' } }],
    });
    expect(
      await service.dispatch('browse', { connection: config, table: 'zwip_fixture' }),
    ).toMatchObject({
      rows: [
        { id: 1, name: 'updated' },
        { id: 2, name: 'two' },
      ],
    });
  });
  it('clips decoded MySQL JSON values without skipping cursor rows', async () => {
    const first = (await service.dispatch('query', {
      connection: config,
      queryId: 'mysql-large-json',
      sql: "SELECT id,JSON_OBJECT('nested',REPEAT('x',1048576)) payload FROM zwip_fixture ORDER BY id",
      limit: 1,
    })) as { rows: { id: number }[]; truncated: boolean };
    expect(first.truncated).toBe(true);
    expect(first.rows[0].id).toBe(1);
    expect(Buffer.byteLength(JSON.stringify(first.rows))).toBeLessThan(100000);
    const second = (await service.dispatch('next', {
      queryId: 'mysql-large-json',
    })) as typeof first;
    expect(second.truncated).toBe(true);
    expect(second.rows[0].id).toBe(2);
    await service.cancel('mysql-large-json');
  });
  it('rejects duplicate MySQL result labels and accepts distinct aliases', async () => {
    await expect(
      service.dispatch('query', {
        connection: config,
        queryId: 'duplicate',
        sql: 'SELECT 1 id,2 id',
      }),
    ).rejects.toThrow('Use unique column aliases');
    expect(
      await service.dispatch('query', {
        connection: config,
        queryId: 'duplicate',
        sql: 'SELECT 1 first_id,2 second_id',
      }),
    ).toMatchObject({ rows: [{ first_id: '1', second_id: '2' }] });
    await service.cancel('duplicate');
  });
  it('cancels the owned server query as well as its local process', async () => {
    const pending = service.dispatch('query', {
      connection: config,
      queryId: 'sleep',
      sql: 'SELECT SLEEP(30)',
    });
    const rejection = expect(pending).rejects.toThrow(/canceled|exited/);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await service.cancel('sleep');
    await rejection;
    const db = await mysql.createConnection({
      host: '127.0.0.1',
      port,
      user: 'root',
      database: 'zwip_test',
    });
    const [rows] = await db.query<mysql.RowDataPacket[]>('SHOW PROCESSLIST');
    expect(rows.some((row) => row.Info === 'SELECT SLEEP(30)')).toBe(false);
    await db.end();
  });
});
