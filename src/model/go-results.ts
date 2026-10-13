import type { CoverageFile, GoJob, GoTestEvent } from './go-types';
export function coverageLines(file: CoverageFile): { line: number; count: number }[] {
  const lines = new Map<number, number>();
  for (const block of file.blocks) {
    if (block.statements === 0) continue;
    const last = block.range.end.line - (block.range.end.character === 0 ? 1 : 0);
    for (let line = block.range.start.line; line <= last; line++)
      lines.set(line, Math.min(lines.get(line) ?? block.count, block.count));
  }
  return [...lines].sort(([a], [b]) => a - b).map(([line, count]) => ({ line, count }));
}
export function collectGoEvents(job: GoJob, after: number) {
  const events = job.events.filter((event) => event.sequence > after);
  return {
    cursor: Math.max(job.cursor, after),
    output: events.map((event) => (event.test?.Output ?? '') + (event.text ?? '')).join(''),
    tests: events.flatMap((event) =>
      event.test?.Test && event.test.Action !== 'output' ? [event.test] : [],
    ),
  };
}
export function updateGoTests(current: Map<string, GoTestEvent>, events: GoTestEvent[]) {
  const next = new Map(current);
  for (const test of events)
    next.set(`${test.Package}:${test.Test}`, {
      ...next.get(`${test.Package}:${test.Test}`),
      ...test,
    });
  return next;
}
export async function matchesCoverage(content: string, hash: string): Promise<boolean> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return (
    [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('') === hash
  );
}
