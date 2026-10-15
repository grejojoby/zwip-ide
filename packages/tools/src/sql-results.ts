import { resultPreview } from './result-preview';
import type { Row } from './sql-driver';

export function queryColumns(names: string[]): string[] {
  if (new Set(names).size !== names.length)
    throw new Error('Query result contains duplicate column names. Use unique column aliases.');
  return names;
}

/** Retain only bounded previews as a cursor yields rows, never an entire page
 * of raw large cells. A truncated page is read-only in the renderer. */
export class RowPage {
  private rows: Row[] = [];
  private truncated = false;
  private rowBudget: number;
  constructor(private maxRows = 500) {
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 500)
      throw new Error('A result page must contain between 1 and 500 rows.');
    this.rowBudget = Math.floor((4 * 1024 * 1024 - 2) / maxRows) - 1;
  }
  add(row: Row) {
    if (this.rows.length >= this.maxRows) throw new Error('Result page row limit exceeded.');
    // Reserve a share for every requested row. A large early value may lose
    // fields, but cannot consume the page and silently discard later rows.
    const preview = resultPreview(row, { bytes: this.rowBudget, nodes: 8192 });
    this.truncated ||= preview.truncated;
    this.rows.push((preview.value ?? {}) as Row);
  }
  result() {
    return { rows: this.rows, truncated: this.truncated };
  }
}
