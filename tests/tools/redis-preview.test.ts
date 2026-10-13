import { expect, it } from 'vitest';
import { redisPreview } from '../../packages/tools/src/redis-preview';

it('bounds large collection values without changing small values', () => {
  const value = [{ field: 'field', value: 'value' }];
  expect(redisPreview(value)).toEqual({ value, truncated: false });
  const large = Array.from({ length: 100 }, () => ({
    field: 'key',
    value: 'x'.repeat(1024 * 1024),
  }));
  const result = redisPreview(large);
  expect(result.truncated).toBe(true);
  expect(JSON.stringify(result.value).length).toBeLessThan(530000);
  expect(large[0].value.length).toBe(1024 * 1024);
});

it('bounds many small members and preserves Unicode boundaries', () => {
  const many = redisPreview(Array.from({ length: 100000 }, () => 'a'));
  expect(many.truncated).toBe(true);
  expect((many.value as string[]).length).toBeLessThan(2049);
  const unicode = redisPreview('a'.repeat(65535) + '😀tail');
  expect(unicode.truncated).toBe(true);
  expect(unicode.value).not.toContain('\ud83d');
});
