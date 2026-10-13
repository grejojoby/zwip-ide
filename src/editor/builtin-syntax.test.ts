import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { builtinKey, builtinSyntax } from './builtin-syntax';

async function nodeNames(path: string, doc: string) {
  const extension = await builtinSyntax(path);
  expect(extension).not.toBeNull();
  const state = EditorState.create({ doc, extensions: [extension!] });
  const names = new Set<string>();
  syntaxTree(state).iterate({ enter: (node) => void names.add(node.name) });
  return names;
}

describe('built-in syntax', () => {
  it.each([
    ['main.go', 'package main\nfunc main() {}\n'],
    ['app.tsx', 'const a: number = 1;\n'],
    ['page.html', '<p class="a">x</p>\n'],
    ['style.css', 'a { color: red }\n'],
    ['q.sql', 'SELECT 1;\n'],
    ['x.py', 'def f():\n  return 1\n'],
    ['x.rs', 'fn main() {}\n'],
    ['x.yaml', 'a: 1\n'],
    ['x.toml', 'a = 1\n'],
    ['run.sh', 'echo hi\n'],
    ['go.mod', 'module x\n'],
    ['Dockerfile', 'FROM scratch\n'],
  ])('provides a grammar for %s', async (path, doc) => {
    expect((await nodeNames(path, doc)).size).toBeGreaterThan(1);
  });
  it('returns null for unknown types', () => {
    expect(builtinSyntax('notes.txt')).toBeNull();
    expect(builtinSyntax('Makefile')).toBeNull();
  });
  it('keys name-matched files separately from their extension', () => {
    expect(builtinKey('/a/go.mod')).toBe('go.mod');
    expect(builtinKey('/a/other.mod')).toBe('mod');
    expect(builtinKey('/a/CMakeLists.txt')).toBe('cmakelists.txt');
    expect(builtinKey('/a/notes.txt')).toBe('txt');
  });
});
