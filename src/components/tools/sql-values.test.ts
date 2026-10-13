import { describe, expect, it } from 'vitest';
import { parseCell } from './sql-values';
import type { SqlColumn } from '../../contracts';
const column: SqlColumn = { name: 'amount', type: 'DECIMAL', nullable: true, primaryKey: false };
describe('SQL edits preserve driver values', () => {
  it('preserves numeric strings without rounding database precision', () => {
    expect(parseCell('9007199254740993.01', '0.00', column, false)).toBe('9007199254740993.01');
  });
  it('validates numeric and boolean representations', () => {
    expect(parseCell('12.5', 1.5, column, false)).toBe(12.5);
    expect(() => parseCell('no', 1, column, false)).toThrow('finite number');
    expect(() => parseCell('9007199254740993', 1, column, false)).toThrow('safely');
    expect(parseCell('false', true, column, false)).toBe(false);
  });
  it('distinguishes an empty string from NULL and respects nullability', () => {
    expect(parseCell('', 'before', column, false)).toBe('');
    expect(parseCell('', 'before', column, true)).toBe(null);
    expect(() => parseCell('', 'before', { ...column, nullable: false }, true)).toThrow(
      'does not allow NULL',
    );
  });
});
