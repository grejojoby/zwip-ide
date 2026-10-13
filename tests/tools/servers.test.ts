import { queryFixture } from './query-fixture';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createClient } from 'redis';
import pg from 'pg';
import { SqlService } from '../../packages/tools/src/sql';
import { RedisService } from '../../packages/tools/src/redis';
let queryWorker: Awaited<ReturnType<typeof queryFixture>>;
beforeAll(async () => {
  queryWorker = await queryFixture();
});
afterAll(() => queryWorker?.dispose());
const postgres = process.env.ZWIP_TEST_POSTGRES ?? '/Applications/ServBay/bin/postgres';
const initdb = process.env.ZWIP_TEST_INITDB ?? '/Applications/ServBay/bin/initdb';
const redisServer = process.env.ZWIP_TEST_REDIS ?? '/Applications/ServBay/bin/redis-server';
async function port() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 3000).unref();
  });
}
async function ready(connect: () => Promise<void>) {
  let error: unknown;
  for (let i = 0; i < 80; i++) {
    try {
      await connect();
      return;
    } catch (cause) {
      error = cause;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw error;
}
describe.skipIf(!existsSync(postgres) || !existsSync(initdb))(
  'disposable PostgreSQL server',
  () => {
    let directory: string,
      child: ChildProcess | undefined,
      service: SqlService,
      config: Record<string, unknown>;
    beforeAll(async () => {
      directory = mkdtempSync(join(tmpdir(), 'zwip-pg-test-'));
      execFileSync(
        initdb,
        ['-D', join(directory, 'data'), '-A', 'trust', '-U', 'zwip_test', '--no-locale'],
        { stdio: 'pipe' },
      );
      const serverPort = await port();
      child = spawn(
        postgres,
        [
          '-D',
          join(directory, 'data'),
          '-h',
          '127.0.0.1',
          '-p',
          String(serverPort),
          '-k',
          directory,
          '-F',
        ],
        { stdio: 'ignore' },
      );
      const pgOptions = {
        host: '127.0.0.1',
        port: serverPort,
        user: 'zwip_test',
        database: 'postgres',
      };
      await ready(async () => {
        const client = new pg.Client(pgOptions);
        await client.connect();
        await client.end();
      });
      const client = new pg.Client(pgOptions);
      await client.connect();
      await client.query(
        "CREATE TABLE things(id INTEGER PRIMARY KEY,name TEXT);INSERT INTO things VALUES(1,'one'),(2,'two')",
      );
      await client.end();
      config = {
        id: 'pg-test',
        kind: 'postgres',
        host: '127.0.0.1',
        port: serverPort,
        username: 'zwip_test',
        database: 'postgres',
      };
      service = new SqlService(queryWorker.path);
    }, 30000);
    afterAll(async () => {
      await service?.dispose();
      await stop(child);
      if (directory) rmSync(directory, { recursive: true, force: true });
    });
    it('bounds large PostgreSQL cells before retaining a cursor page and resets the page budget', async () => {
      const first = (await service.dispatch('query', {
        connection: config,
        queryId: 'large-cells',
        sql: "SELECT n,repeat('x',1000000) payload FROM generate_series(1,3) n",
        limit: 2,
      })) as { rows: { n: string; payload: string }[]; truncated: boolean };
      expect(first.truncated).toBe(true);
      expect(first.rows.map((row) => row.n)).toEqual(['1', '2']);
      expect(Buffer.byteLength(JSON.stringify(first.rows))).toBeLessThan(150000);
      const second = (await service.dispatch('next', { queryId: 'large-cells' })) as typeof first;
      expect(second.truncated).toBe(true);
      expect(second.rows[0].n).toBe('3');
      expect(second.rows[0].payload.length).toBeGreaterThan(60000);
      await service.cancel('large-cells');
    });
    it('rejects duplicate PostgreSQL result labels and accepts distinct aliases', async () => {
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
    it('discovers schema, pages server cursors, and validates row edits', async () => {
      expect(await service.dispatch('schema', { connection: config })).toContainEqual({
        schema: 'public',
        name: 'things',
        type: 'table',
      });
      expect(
        await service.dispatch('query', {
          connection: config,
          queryId: 'pg',
          sql: 'SELECT * FROM things ORDER BY id',
          limit: 1,
        }),
      ).toMatchObject({ rows: [{ id: '1', name: 'one' }], done: false });
      expect(await service.dispatch('next', { queryId: 'pg' })).toMatchObject({
        rows: [{ id: '2', name: 'two' }],
      });
      await service.dispatch('cancel', { queryId: 'pg' });
      expect(
        await service.dispatch('browse', { connection: config, schema: 'public', table: 'things' }),
      ).toMatchObject({ editable: true, primaryKey: ['id'] });
      await service.dispatch('applyEdits', {
        connection: config,
        schema: 'public',
        table: 'things',
        changes: [{ before: { id: '1', name: 'one' }, after: { id: '1', name: 'changed' } }],
      });
      expect(
        await service.dispatch('browse', { connection: config, schema: 'public', table: 'things' }),
      ).toMatchObject({
        rows: [
          { id: '1', name: 'changed' },
          { id: '2', name: 'two' },
        ],
      });
    });
    it('cancels a server query without closing unrelated work', async () => {
      const pending = service.dispatch('query', {
        connection: config,
        queryId: 'sleep',
        sql: 'SELECT pg_sleep(30)',
      });
      const rejection = expect(pending).rejects.toThrow(/canceled|exited/);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await service.cancel('sleep');
      await rejection;
      expect(await service.dispatch('schema', { connection: config })).toContainEqual({
        schema: 'public',
        name: 'things',
        type: 'table',
      });
    });
  },
);
describe.skipIf(!existsSync(redisServer))('disposable Redis server', () => {
  let directory: string,
    child: ChildProcess | undefined,
    service: RedisService,
    config: Record<string, unknown>;
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'zwip-redis-test-'));
    const serverPort = await port();
    child = spawn(
      redisServer,
      [
        '--bind',
        '127.0.0.1',
        '--port',
        String(serverPort),
        '--save',
        '',
        '--appendonly',
        'no',
        '--dir',
        directory,
      ],
      { stdio: 'ignore' },
    );
    config = {
      id: 'redis-test',
      kind: 'redis',
      host: '127.0.0.1',
      port: serverPort,
      database: '0',
    };
    await ready(async () => {
      const client = createClient({
        socket: { host: '127.0.0.1', port: serverPort, reconnectStrategy: false },
      });
      client.on('error', () => {});
      await client.connect();
      client.destroy();
    });
    const client = createClient({ socket: { host: '127.0.0.1', port: serverPort } });
    client.on('error', () => {});
    await client.connect();
    await client.set('fixture:text', 'hello', { EX: 60 });
    await client.hSet('fixture:hash', { field: 'value' });
    await client.lPush('fixture:list', ['one', 'two']);
    client.destroy();
    service = new RedisService();
  }, 10000);
  afterAll(async () => {
    await service?.dispose();
    await stop(child);
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  it('scans incrementally and inspects typed values with TTL', async () => {
    const result = (await service.dispatch('keys', {
      connection: config,
      pattern: 'fixture:*',
    })) as { keys: string[] };
    expect(result.keys.sort()).toEqual(['fixture:hash', 'fixture:list', 'fixture:text']);
    expect(
      await service.dispatch('inspect', { connection: config, key: 'fixture:text' }),
    ).toMatchObject({ type: 'string', value: 'hello', ttl: expect.any(Number) });
    expect(
      await service.dispatch('inspect', { connection: config, key: 'fixture:hash' }),
    ).toMatchObject({ type: 'hash', value: [{ field: 'field', value: 'value' }] });
    await expect(
      service.dispatch('set', { connection: config, key: 'fixture:text', value: 'overwrite' }),
    ).rejects.toThrow('read-only');
  });
  it('disposes connections and permits a later reconnect', async () => {
    await service.dispatch('disconnect', { connectionId: 'redis-test' });
    expect(
      await service.dispatch('inspect', { connection: config, key: 'fixture:text' }),
    ).toMatchObject({ value: 'hello' });
  });
  it('marks large Redis collection values as truncated and bounds the renderer payload', async () => {
    const client = createClient({
      socket: { host: String(config.host), port: Number(config.port) },
    });
    client.on('error', () => {});
    await client.connect();
    try {
      await client.hSet('large:hash', { field: '\0'.repeat(2 * 1024 * 1024) });
      const result = (await service.dispatch('inspect', {
        connection: config,
        key: 'large:hash',
      })) as { value: unknown; truncated: boolean };
      expect(result.truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(result.value))).toBeLessThanOrEqual(512 * 1024);
    } finally {
      client.destroy();
    }
  });
});
