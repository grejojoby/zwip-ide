import { expect, it } from 'vitest';
// @ts-expect-error The standalone benchmark helper runs directly in Node.
import { targetKeys } from '../../scripts/benchmark-targets.mjs';

it('applies an oracle dependency exclusion to in-root node_modules as well as external SDKs', () => {
  const locations = [
    '/workspace/lib/calls.ts',
    '/workspace/node_modules/typescript/lib/lib.es5.d.ts',
    '/sdk/lib.d.ts',
  ].map((path) => ({ path, range: { start: { line: 4, character: 16 } } }));
  const included = new Set(['/workspace/lib/calls.ts']);
  expect(targetKeys(locations, '/workspace', included)).toEqual(['lib/calls.ts:4:16']);
  expect(targetKeys(locations, '/workspace')).toEqual([
    '../sdk/lib.d.ts:4:16',
    'lib/calls.ts:4:16',
    'node_modules/typescript/lib/lib.es5.d.ts:4:16',
  ]);
});
