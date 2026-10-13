import { expect, it } from 'vitest';
import { assignmentsForMove } from './changelists';
import type { Changelist, ChangelistSelection } from '../contracts';
const old: ChangelistSelection = { path: 'a', changeIds: ['add:1'], fingerprint: 'same' };
const target: Changelist = { id: 'feature', name: 'Feature', paths: ['a'], selections: [old] };
it('merges line ownership, preserves whole-file ownership and rejects stale assignments', () => {
  expect(
    assignmentsForMove(target, ['a'], [{ ...old, changeIds: ['add:2'] }])[0].changeIds,
  ).toEqual(['add:1', 'add:2']);
  expect(assignmentsForMove(target, ['a'], [])).toEqual([]);
  expect(assignmentsForMove({ ...target, selections: [] }, ['a'], [old])).toEqual([]);
  expect(() => assignmentsForMove(target, ['a'], [{ ...old, fingerprint: 'new' }])).toThrow(
    'stale',
  );
  expect(assignmentsForMove(target, ['b'], [{ ...old, path: 'b' }])).toEqual([
    old,
    { ...old, path: 'b' },
  ]);
});
