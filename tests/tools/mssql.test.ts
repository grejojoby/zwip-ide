import { describe, expect, it, vi } from 'vitest';
import {
  config,
  quote,
  parameter,
  columns,
  type Driver,
  type Result,
} from '../../packages/tools/src/sql-driver';
import { SqlService } from '../../packages/tools/src/sql';
vi.mock('mssql', () => ({ default: { ConnectionPool: vi.fn() } }));

it('accepts SQL Server and quotes identifiers and binds parameters without interpolation', () => {
  expect(config({ id: 'sqlserver', kind: 'mssql' }).kind).toBe('mssql');
  expect(quote('a]b', 'mssql')).toBe('[a]]b]');
  expect(parameter(2, 'mssql')).toBe('@p2');
});
describe('SQL Server metadata', () => {
  it('discovers tables and views using the SQL Server catalogs', async () => {
    const query = vi.fn<(text: string, values?: unknown[]) => Promise<Result>>(async () => ({
      rows: [{ schema: 'sales', name: 'orders', type: 'table' }],
      affected: 0,
    }));
    const driver = { kind: 'mssql', query, close: vi.fn() } as Driver;
    const spy = vi
      .spyOn(await import('../../packages/tools/src/sql-driver'), 'connect')
      .mockResolvedValue(driver);
    try {
      expect(
        await new SqlService().dispatch('schema', { connection: { id: 'c', kind: 'mssql' } }),
      ).toEqual([{ schema: 'sales', name: 'orders', type: 'table' }]);
      expect(query.mock.calls[0][0]).toContain('sys.objects');
    } finally {
      spy.mockRestore();
    }
  });
  it('reads column metadata with bound schema and table names', async () => {
    const query = vi.fn<(text: string, values?: unknown[]) => Promise<Result>>(async () => ({
      rows: [{ name: 'id', type: 'int', nullable: false, pk: true }],
      affected: 0,
    }));
    const result = await columns(
      { kind: 'mssql', query, close: vi.fn() } as Driver,
      { kind: 'mssql', id: 'c' },
      'sales',
      "orders'; DROP TABLE t;--",
    );
    expect(result).toEqual([{ name: 'id', type: 'int', nullable: false, primaryKey: true }]);
    expect(query.mock.calls[0]).toEqual([
      expect.stringContaining('sys.columns'),
      ['sales', "orders'; DROP TABLE t;--"],
    ]);
  });
});
it('returns procedure docs, SQL definition and parameters while binding the procedure name', async () => {
  const query = vi.fn<(text: string, values?: unknown[]) => Promise<Result>>(async (text) => ({
    rows: text.includes('sys.parameters')
      ? [{ name: '@id', type: '[sys].[int]', output: true, description: 'Order ID' }]
      : [
          {
            id: 123,
            schema: 'sales',
            name: "odd'name",
            description: 'Lookup',
            definition: 'CREATE PROCEDURE ...',
          },
        ],
    affected: 0,
  }));
  const spy = vi
    .spyOn(await import('../../packages/tools/src/sql-driver'), 'connect')
    .mockResolvedValue({ kind: 'mssql', query, close: vi.fn() });
  try {
    expect(
      await new SqlService().dispatch('procedureDetails', {
        connection: { id: 'c', kind: 'mssql' },
        schema: 'sales',
        procedure: "odd'name",
      }),
    ).toMatchObject({
      description: 'Lookup',
      definition: 'CREATE PROCEDURE ...',
      parameters: [{ name: '@id', output: true }],
    });
    expect(query.mock.calls[0][1]).toEqual(['sales', "odd'name"]);
    expect(query.mock.calls[0][0]).toContain('sys.extended_properties');
    expect(query.mock.calls[1][1]).toEqual([123]);
  } finally {
    spy.mockRestore();
  }
});
it('uses OFFSET/FETCH for SQL Server table browsing and never LIMIT', async () => {
  const query = vi.fn<(text: string, values?: unknown[]) => Promise<Result>>(async (text) => ({
    rows: text.includes('sys.columns')
      ? [{ name: 'id', type: 'int', nullable: false, pk: true }]
      : [{ id: 1 }],
    affected: 0,
  }));
  const spy = vi
    .spyOn(await import('../../packages/tools/src/sql-driver'), 'connect')
    .mockResolvedValue({ kind: 'mssql', query, close: vi.fn() });
  try {
    expect(
      await new SqlService().dispatch('browse', {
        connection: { id: 'c', kind: 'mssql' },
        schema: 'dbo',
        table: 't',
        limit: 1,
        offset: 2,
      }),
    ).toMatchObject({ rows: [{ id: 1 }], primaryKey: ['id'] });
    expect(query.mock.calls[1][0]).toBe(
      'SELECT * FROM [dbo].[t] ORDER BY [id] OFFSET 2 ROWS FETCH NEXT 2 ROWS ONLY',
    );
  } finally {
    spy.mockRestore();
  }
});
