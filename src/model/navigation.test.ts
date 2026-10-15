import { describe, expect, it } from 'vitest';
import { isCurrentResult, NavigationHistory, shouldFindUsages } from './navigation';
import type { NavigationBatch, SourceLocation } from '../contracts';
const location: SourceLocation = {
  path: '/a.ts',
  range: { start: { line: 2, character: 4 }, end: { line: 2, character: 10 } },
  preview: '',
  name: 'target',
  relationship: 'definition',
  contextIds: ['a'],
};
describe('Semantic navigation', () => {
  it('uses declaration identity to turn Cmd-click into find usages', () => {
    expect(shouldFindUsages([location], '/a.ts', { line: 2, character: 6 })).toBe(true);
    expect(shouldFindUsages([location], '/a.ts', { line: 7, character: 6 })).toBe(false);
    expect(shouldFindUsages([], '/a.ts', { line: 2, character: 6 })).toBe(false);
  });
  it('does not turn ambiguous declarations into usages', () => {
    expect(
      shouldFindUsages([location, { ...location, path: '/b.ts' }], '/a.ts', {
        line: 2,
        character: 6,
      }),
    ).toBe(false);
  });
  it('finds usages when the caret is immediately after the declaration name', () => {
    expect(shouldFindUsages([location], '/a.ts', location.range.end)).toBe(true);
    expect(shouldFindUsages([location], '/a.ts', { line: 2, character: 11 })).toBe(false);
  });
  it('rejects results from obsolete documents, workspaces, and query IDs', () => {
    const batch: NavigationBatch = {
      id: 'current',
      documentRevision: 3,
      workspaceGeneration: 5,
      state: 'complete',
      locations: [],
      searchedContexts: 1,
      totalContexts: 1,
      reasons: [],
    };
    expect(isCurrentResult(batch, 'current', 3, 5)).toBe(true);
    expect(isCurrentResult(batch, 'old', 3, 5)).toBe(false);
    expect(isCurrentResult(batch, 'current', 4, 5)).toBe(false);
    expect(isCurrentResult(batch, 'current', 3, 6)).toBe(false);
  });
  it('drops the forward branch after visiting a new target', () => {
    const history = new NavigationHistory();
    const position = { line: 0, character: 0 };
    history.visit('a', position);
    history.visit('b', position);
    history.visit('c', position);
    expect(history.back()?.path).toBe('b');
    history.visit('d', position);
    expect(history.forward()).toBeUndefined();
    expect(history.back()?.path).toBe('b');
  });
  it('preserves unrelated history when files are moved or trashed', () => {
    const history = new NavigationHistory();
    const position = { line: 1, character: 2 };
    history.visit('a', position);
    history.visit('b', position, 'old-context');
    history.visit('c', position);
    history.relocate('b', 'moved');
    expect(history.back()).toEqual({ path: 'moved', position, sourceContextId: undefined });
    history.relocate('moved');
    expect(history.forward()?.path).toBe('c');
    expect(history.back()?.path).toBe('a');
  });
});
