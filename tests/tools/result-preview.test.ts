import { expect, it } from 'vitest';
import { resultPreview } from '../../packages/tools/src/result-preview';
import { RowPage, safeRows } from '../../packages/tools/src/sql-driver';
import { redisPreview } from '../../packages/tools/src/redis-preview';

it('bounds escaped and multibyte JSON by serialized bytes, with explicit truncation', () => {
  for (const text of ['\0', '\\', '😀', '漢']) {
    const input = Array.from({ length: 100 }, () => text.repeat(100000));
    const preview = redisPreview(input);
    expect(preview.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(preview.value))).toBeLessThanOrEqual(512 * 1024);
  }
});

it('clips nested SQL JSON without invoking its unbounded serializer', () => {
  let serialized = false;
  const value = {
    nested: { payload: '\0'.repeat(2 * 1024 * 1024) },
    toJSON() {
      serialized = true;
      throw new Error('must not serialize raw input');
    },
  };
  const page = safeRows([{ id: 1, document: value }]);
  expect(page.truncated).toBe(true);
  expect(serialized).toBe(false);
  expect(Buffer.byteLength(JSON.stringify(page.rows))).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(value.nested.payload.length).toBe(2 * 1024 * 1024);
});

it('bounds traversal nodes and depth, and does not retain cyclic or prototype properties', () => {
  const input: Record<string, unknown> = Object.create({ inherited: 'not data' });
  input.first = 'kept';
  input.circular = input;
  const preview = resultPreview(input, { bytes: 1024, nodes: 10 });
  expect(preview).toEqual({ value: { first: 'kept' }, truncated: true });
  const huge = resultPreview(
    Array.from({ length: 100000 }, () => 1),
    { bytes: 1024, nodes: 10 },
  );
  expect(huge.truncated).toBe(true);
  expect((huge.value as number[]).length).toBeLessThan(10);
});

it('keeps binary previews valid base64 and small SQL values unchanged', () => {
  const input = Buffer.alloc(1024 * 1024, 7);
  const page = safeRows([{ bytes: input }]);
  const preview = page.rows[0].bytes as { type: string; base64: string };
  expect(preview.type).toBe('bytes');
  expect(Buffer.from(preview.base64, 'base64')).toEqual(input.subarray(0, 65536));
  expect(page.truncated).toBe(true);
  expect(safeRows([{ id: 42n, text: 'hello', nil: null, nested: { ok: true } }])).toEqual({
    rows: [{ id: '42', text: 'hello', nil: null, nested: { ok: true } }],
    truncated: false,
  });
});

it('retains a bounded page while incrementally consuming many large rows', () => {
  const page = new RowPage();
  const input = { value: '\0'.repeat(1024 * 1024) };
  for (let index = 0; index < 500; index++) page.add(input);
  const result = page.result();
  expect(result.truncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result.rows))).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(result.rows.length).toBe(500);
});
