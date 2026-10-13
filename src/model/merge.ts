export interface MergeConflict {
  from: number;
  to: number;
  ours: string;
  theirs: string;
}
/** Offsets refer to the unchanged result buffer. Supports ordinary and diff3 markers. */
export function mergeConflicts(content: string): MergeConflict[] {
  const conflicts: MergeConflict[] = [];
  const lines = content.split(/(?<=\n)/);
  let offset = 0;
  let current: {
    from: number;
    ours: string;
    theirs: string;
    part: 'ours' | 'base' | 'theirs';
  } | null = null;
  for (const line of lines) {
    if (/^<<<<<<<(?:\s|$)/.test(line))
      current = { from: offset, ours: '', theirs: '', part: 'ours' };
    else if (current && /^\|\|\|\|\|\|\|(?:\s|$)/.test(line)) current.part = 'base';
    else if (current && /^=======(?:\r?\n)?$/.test(line)) current.part = 'theirs';
    else if (current && /^>>>>>>>(?:\s|$)/.test(line)) {
      conflicts.push({
        from: current.from,
        to: offset + line.length,
        ours: current.ours,
        theirs: current.theirs,
      });
      current = null;
    } else if (current?.part === 'ours') current.ours += line;
    else if (current?.part === 'theirs') current.theirs += line;
    offset += line.length;
  }
  return conflicts;
}
