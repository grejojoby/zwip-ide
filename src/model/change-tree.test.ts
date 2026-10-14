import { expect, it } from 'vitest';
import { changeTree } from './change-tree';

const paths = [
  'docs/flows/keyword-block-serving.md',
  'renderly/app/cmd/serving/app.go',
  'renderly/app/pkg/adsfetcher/adsfetcher.go',
  'renderly/app/pkg/adsfetcher/adsfetcher_test.go',
  'go.mod',
].map((path) => ({ path }));
const shape = (rows: ReturnType<typeof changeTree<{ path: string }>>) =>
  rows.map(
    (row) =>
      `${'  '.repeat(row.depth)}${row.label}${row.kind === 'directory' ? `/ (${row.files.length})` : ''}`,
  );

it('groups changes by directory, merging single-child chains like IntelliJ', () => {
  expect(shape(changeTree(paths))).toEqual([
    'docs/flows/ (1)',
    '  keyword-block-serving.md',
    'renderly/app/ (3)',
    '  cmd/serving/ (1)',
    '    app.go',
    '  pkg/adsfetcher/ (2)',
    '    adsfetcher.go',
    '    adsfetcher_test.go',
    'go.mod',
  ]);
});

it('hides the contents of collapsed directories', () => {
  expect(shape(changeTree(paths, new Set(['renderly/app'])))).toEqual([
    'docs/flows/ (1)',
    '  keyword-block-serving.md',
    'renderly/app/ (3)',
    'go.mod',
  ]);
});
