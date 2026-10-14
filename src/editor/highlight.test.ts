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
    expect(classOf(lines, 'conf')).toBeUndefined();
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
  it('colors Go packages, types, builtins, receivers and struct tags like GoLand', async () => {
    const source = [
      'package main',
      'import (',
      '\tm "example.com/mowxrequest"',
      '\t"example.com/entitymanager"',
      '\t"gopkg.in/yaml.v3"',
      ')',
      'type App struct {',
      '\tNative m.Request `json:"native,omitempty"`',
      '\tEnabled bool',
      '\tKeywords',
      '}',
      'func (a *App) url(em *entitymanager.Manager) string {',
      '\tout := yaml.Marshal(a.Native, em.Get(), App{Enabled: false})',
      '\treturn string(out)',
      '}',
    ].join('\n');
    const lines = await highlightLines('main.go', source);
    const at = (line: number, text: string) =>
      lines[line].find((token) => token.text === text)?.className;
    expect(at(0, 'main')).toBe('tok-package');
    expect(at(2, 'm')).toBe('tok-package');
    expect(at(7, 'Native')).toBeUndefined();
    expect(at(7, 'm')).toBe('tok-package');
    expect(at(7, 'Request')).toBe('tok-type');
    expect(at(7, '`json:')).toBe('tok-string tok-struct-tag');
    expect(at(7, '"native,omitempty"')).toBe('tok-string');
    expect(at(8, 'bool')).toBe('tok-type tok-builtin');
    expect(at(9, 'Keywords')).toBe('tok-type');
    expect(at(11, 'a')).toBe('tok-receiver');
    expect(at(11, 'App')).toBe('tok-type');
    expect(at(11, 'url')).toBe('tok-function-declaration');
    expect(at(11, 'em')).toBeUndefined();
    expect(at(11, 'entitymanager')).toBe('tok-package');
    expect(at(11, 'Manager')).toBe('tok-type');
    expect(at(11, 'string')).toBe('tok-type tok-builtin');
    expect(at(12, 'out')).toBeUndefined();
    expect(at(12, 'yaml')).toBe('tok-package');
    expect(at(12, 'Marshal')).toBe('tok-function-call');
    expect(at(12, 'a')).toBe('tok-receiver');
    expect(at(12, 'em')).toBeUndefined();
    expect(at(12, 'Get')).toBe('tok-function-call');
    expect(at(13, 'string')).toBe('tok-function-call tok-builtin');
    expect(lines.map((line) => line.map((token) => token.text).join('')).join('\n')).toBe(source);
  });
  it('returns plain text for file types without a grammar', async () => {
    expect(await highlightLines('notes.txt', 'a\nb')).toEqual([[{ text: 'a' }], [{ text: 'b' }]]);
  });
});
