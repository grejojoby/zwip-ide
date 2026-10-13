// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { highlightLines } from './highlight';

vi.mock('../api', () => ({ request: async () => null }));

const classOf = (lines: Awaited<ReturnType<typeof highlightLines>>, text: string) =>
  lines.flat().find((token) => token.text === text)?.className;

describe('code highlighting', () => {
  it('colors Go like GoLand: keywords, declarations, calls, fields, strings and comments', async () => {
    const lines = await highlightLines(
      'main.go',
      [
        'package main',
        '// Run starts it.',
        'func (s *Server) Run() { s.conf.Load(); print("x"); return }',
        'const limit = 3',
      ].join('\n'),
    );
    expect(lines).toHaveLength(4);
    expect(classOf(lines, 'package')).toBe('tok-keyword');
    expect(classOf(lines, '// Run starts it.')).toBe('tok-comment');
    expect(classOf(lines, 'Run')).toBe('tok-function-declaration');
    expect(classOf(lines, 'conf')).toBe('tok-field');
    expect(classOf(lines, 'Load')).toBe('tok-function-call');
    expect(classOf(lines, 'print')).toBe('tok-function-call');
    expect(classOf(lines, '"x"')).toBe('tok-string');
    expect(classOf(lines, 'limit')).toBe('tok-constant');
    expect(classOf(lines, '3')).toBe('tok-number');
    expect(lines.map((line) => line.map((token) => token.text).join(''))).toEqual([
      'package main',
      '// Run starts it.',
      'func (s *Server) Run() { s.conf.Load(); print("x"); return }',
      'const limit = 3',
    ]);
  });
  it('returns plain text for file types without a grammar', async () => {
    expect(await highlightLines('notes.txt', 'a\nb')).toEqual([[{ text: 'a' }], [{ text: 'b' }]]);
  });
});
