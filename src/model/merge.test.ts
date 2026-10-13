import { expect, it } from 'vitest';
import { mergeConflicts } from './merge';
it('resolves diff3 blocks without including base text or touching adjacent edits', () => {
  const content =
    'before\n<<<<<<< HEAD\nours\n||||||| base\nold\n=======\ntheirs\n>>>>>>> feature\nafter\n';
  const [conflict] = mergeConflicts(content);
  expect(conflict.ours).toBe('ours\n');
  expect(conflict.theirs).toBe('theirs\n');
  expect(content.slice(0, conflict.from) + conflict.ours + content.slice(conflict.to)).toBe(
    'before\nours\nafter\n',
  );
});
it('locates multiple conflicts with UTF-16 offsets and CRLF lines', () => {
  const content = '😀\r\n<<<<<<< a\r\nA\r\n=======\r\nB\r\n>>>>>>> b\r\n';
  const [conflict] = mergeConflicts(content);
  expect(conflict.from).toBe(4);
  expect(conflict.theirs).toBe('B\r\n');
  expect(conflict.to).toBe(content.length);
});
