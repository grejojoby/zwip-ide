import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import mssql from 'mssql';
import { connectMssql, mssqlConfig, mssqlQuery } from '../../packages/tools/src/sql-mssql';
type Event =
  ['recordset', { name: string }[]] | ['row', unknown[]] | ['done', { rowsAffected: number[] }];
class Request extends EventEmitter {
  stream = false;
  arrayRowMode = false;
  paused = false;
  canceled = false;
  wake?: () => void;
  constructor(private events: Event[]) {
    super();
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
    this.wake?.();
  }
  cancel() {
    this.canceled = true;
    this.resume();
  }
  async query() {
    for (const [name, value] of this.events) {
      if (this.paused)
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
      if (this.canceled) return;
      this.emit(name, value);
      await Promise.resolve();
    }
  }
}
function fixture(events: Event[]) {
  const request = new Request(events);
  const pool = { request: () => request, close: vi.fn(async () => {}) };
  vi.spyOn(mssql.ConnectionPool.prototype, 'connect').mockImplementation(() =>
    Promise.resolve(pool as unknown as mssql.ConnectionPool),
  );
  return { request, pool };
}
afterEach(() => vi.restoreAllMocks());
it('defaults to encrypted SQL authentication with certificate verification', () => {
  expect(
    mssqlConfig({ id: 'c', kind: 'mssql', username: 'user', password: 'secret' }),
  ).toMatchObject({
    server: '127.0.0.1',
    port: 1433,
    user: 'user',
    password: 'secret',
    options: { encrypt: true, trustServerCertificate: false },
  });
});
it('pages SQL Server results without mixing different result-set columns', async () => {
  const { request, pool } = fixture([
    ['recordset', [{ name: 'id' }]],
    ['row', [1]],
    ['row', [2]],
    ['recordset', [{ name: 'name' }]],
    ['row', ['next']],
    ['done', { rowsAffected: [2, 1] }],
  ]);
  const query = await mssqlQuery({ id: 'c', kind: 'mssql' }, 'EXEC dbo.Example', 2);
  expect(await query.next()).toMatchObject({
    columns: ['id'],
    rows: [{ id: 1 }, { id: 2 }],
    done: false,
    resultSet: 1,
  });
  expect(await query.next()).toMatchObject({
    columns: ['name'],
    rows: [{ name: 'next' }],
    done: true,
    resultSet: 2,
    affectedRows: 3,
  });
  await query.close();
  expect(request.canceled).toBe(true);
  expect(pool.close).toHaveBeenCalled();
});
it('preserves empty result sets and rejects duplicate labels instead of corrupting rows', async () => {
  fixture([
    ['recordset', [{ name: 'empty' }]],
    ['recordset', [{ name: 'id' }]],
    ['row', [3]],
    ['done', { rowsAffected: [1] }],
  ]);
  const query = await mssqlQuery({ id: 'c', kind: 'mssql' }, 'SELECT 1 WHERE 1=0; SELECT 3', 100);
  expect(await query.next()).toMatchObject({
    columns: ['empty'],
    rows: [],
    done: false,
    resultSet: 1,
  });
  expect(await query.next()).toMatchObject({
    columns: ['id'],
    rows: [{ id: 3 }],
    done: true,
    resultSet: 2,
  });
  await query.close();
  vi.restoreAllMocks();
  const { request } = fixture([['recordset', [{ name: 'id' }, { name: 'id' }]]]);
  const duplicate = await mssqlQuery({ id: 'c', kind: 'mssql' }, 'SELECT 1 id,2 id', 100);
  await expect(duplicate.next()).rejects.toThrow('unique column aliases');
  expect(request.canceled).toBe(true);
  await duplicate.close();
});
it('keeps a late server error visible between pages', async () => {
  const { request } = fixture([
    ['recordset', [{ name: 'id' }]],
    ['row', [1]],
  ]);
  const query = await mssqlQuery({ id: 'c', kind: 'mssql' }, 'SELECT 1', 1);
  await query.next();
  request.emit('error', new Error('Server disconnected'));
  await expect(query.next()).rejects.toThrow('Server disconnected');
  await query.close();
});
it('uses array rows for metadata so duplicate labels cannot overwrite values', async () => {
  const request = {
    arrayRowMode: false,
    input: vi.fn(),
    query: vi.fn(async () => ({
      columns: [[{ name: 'value' }]],
      recordset: [['exact']],
      rowsAffected: [1],
    })),
  };
  const pool = { request: () => request, close: vi.fn(async () => {}) };
  vi.spyOn(mssql.ConnectionPool.prototype, 'connect').mockImplementation(() =>
    Promise.resolve(pool as unknown as mssql.ConnectionPool),
  );
  const driver = await connectMssql({ id: 'c', kind: 'mssql' });
  expect(await driver.query('SELECT @p1 value', ["a';--"])).toEqual({
    rows: [{ value: 'exact' }],
    affected: 1,
  });
  expect(request.input).toHaveBeenCalledWith('p1', "a';--");
  expect(request.arrayRowMode).toBe(true);
  await driver.close();
});
it('does not skip consecutive empty result sets between nonempty sets', async () => {
  fixture([
    ['recordset', [{ name: 'one' }]],
    ['row', [1]],
    ['recordset', [{ name: 'emptyA' }]],
    ['recordset', [{ name: 'emptyB' }]],
    ['recordset', [{ name: 'last' }]],
    ['row', [4]],
    ['done', { rowsAffected: [1, 0, 0, 1] }],
  ]);
  const query = await mssqlQuery({ id: 'c', kind: 'mssql' }, 'EXEC dbo.Example', 100);
  expect(await query.next()).toMatchObject({ rows: [{ one: 1 }], resultSet: 1 });
  expect(await query.next()).toMatchObject({ rows: [], columns: ['emptyA'], resultSet: 2 });
  expect(await query.next()).toMatchObject({ rows: [], columns: ['emptyB'], resultSet: 3 });
  expect(await query.next()).toMatchObject({ rows: [{ last: 4 }], resultSet: 4, done: true });
  await query.close();
});
