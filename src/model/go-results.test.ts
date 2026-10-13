import { describe, expect, it } from 'vitest';
import { collectGoEvents, coverageLines, matchesCoverage, updateGoTests } from './go-results';
import type { CoverageFile, GoJob } from './go-types';
describe('Go tool result handling', () => {
  it('does not replay canceled-job events or move its event cursor backward', () => {
    const job: GoJob = {
      id: '1',
      status: 'canceled',
      cursor: 2,
      reasons: [],
      events: [
        { sequence: 1, kind: 'output', text: 'old' },
        { sequence: 2, kind: 'test', test: { Package: 'x', Test: 'TestX', Action: 'pass' } },
      ],
    };
    expect(collectGoEvents(job, 4)).toEqual({ cursor: 4, output: '', tests: [] });
    const current = new Map([['x:TestX', { Package: 'x', Test: 'TestX', Action: 'run' }]]);
    expect(updateGoTests(current, collectGoEvents(job, 1).tests).get('x:TestX')?.Action).toBe(
      'pass',
    );
    expect(current.get('x:TestX')?.Action).toBe('run');
  });
  it('keeps partially uncovered lines visible and excludes an exclusive end line', () => {
    const file: CoverageFile = {
      path: 'x',
      fileHash: '',
      totalStatements: 2,
      coveredStatements: 1,
      percent: 50,
      blocks: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
          statements: 1,
          count: 4,
        },
        {
          range: { start: { line: 1, character: 2 }, end: { line: 1, character: 9 } },
          statements: 1,
          count: 0,
        },
      ],
    };
    expect(coverageLines(file)).toEqual([
      { line: 0, count: 4 },
      { line: 1, count: 0 },
    ]);
  });
  it('rejects stale coverage after source changes', async () => {
    const hash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    expect(await matchesCoverage('', hash)).toBe(true);
    expect(await matchesCoverage('edited', hash)).toBe(false);
  });
});
