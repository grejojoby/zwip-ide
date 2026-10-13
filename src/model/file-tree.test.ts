import { expect, it } from 'vitest';
import { buildTree, flattenTree } from './file-tree';
it('exposes only expanded directories without losing source files', () => {
  const files = ['src/main.ts', 'src/lib/util.ts', 'README.md'].map((relativePath) => ({
    relativePath,
    path: `/project/${relativePath}`,
    size: 1,
  }));
  const tree = buildTree(files);
  expect(flattenTree(tree, new Set()).map((item) => item.id)).toEqual(['src', 'README.md']);
  expect(flattenTree(tree, new Set(['src', 'src/lib'])).map((item) => item.id)).toEqual([
    'src',
    'src/lib',
    'src/lib/util.ts',
    'src/main.ts',
    'README.md',
  ]);
});
it('retains empty directories and deduplicates directories inferred from files', () => {
  const tree = buildTree(
    [{ path: '/project/src/main.ts', relativePath: 'src/main.ts', size: 1 }],
    ['empty/nested', 'src'],
  );
  expect(
    flattenTree(tree, new Set(['empty', 'src'])).map((entry) => [entry.id, entry.directory]),
  ).toEqual([
    ['empty', true],
    ['empty/nested', true],
    ['src', true],
    ['src/main.ts', false],
  ]);
});
