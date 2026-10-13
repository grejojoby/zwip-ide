import type { Changelist, ChangelistSelection } from '../contracts';

/** Adding lines to a list preserves any lines it already owns in the same file. */
export function assignmentsForMove(
  target: Changelist,
  paths: string[],
  selected: ChangelistSelection[],
): ChangelistSelection[] {
  const moving = new Set(paths);
  const existing = new Map((target.selections ?? []).map((item) => [item.path, item]));
  const partial = new Map(selected.map((item) => [item.path, item]));
  const result = (target.selections ?? []).filter((item) => !moving.has(item.path));
  for (const path of paths) {
    const next = partial.get(path);
    if (!next) continue; // An explicit whole-file move replaces its partial assignment.
    const previous = existing.get(path);
    if (!previous && target.paths.includes(path)) continue; // Already owns the entire file.
    if (previous && (previous.stale || previous.fingerprint !== next.fingerprint))
      throw new Error('The target changelist has stale lines; review them before moving changes.');
    result.push({
      ...next,
      changeIds: [...new Set([...(previous?.changeIds ?? []), ...next.changeIds])],
    });
  }
  return result;
}
