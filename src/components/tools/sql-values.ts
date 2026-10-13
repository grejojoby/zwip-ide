import type { SqlColumn } from '../../contracts';
export function cellText(value: unknown): string {
  if (value === null) return 'NULL';
  if (value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
/** Preserve driver representations: large integers/decimals represented as strings stay strings. */
export function parseCell(
  text: string,
  original: unknown,
  column: SqlColumn,
  isNull: boolean,
): unknown {
  if (isNull) {
    if (!column.nullable) throw new Error(`${column.name} does not allow NULL.`);
    return null;
  }
  if (typeof original === 'number') {
    if (!text.trim() || !Number.isFinite(Number(text))) throw new Error('Enter a finite number.');
    const value = Number(text);
    if (Number.isInteger(value) && !Number.isSafeInteger(value))
      throw new Error('Value cannot be represented safely as an integer.');
    return value;
  }
  if (typeof original === 'boolean') {
    if (!['true', 'false'].includes(text)) throw new Error('Enter true or false.');
    return text === 'true';
  }
  if (original !== null && typeof original !== 'string')
    throw new Error('This value type is read only.');
  return text;
}
