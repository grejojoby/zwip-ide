import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as state from '@codemirror/state';
import * as view from '@codemirror/view';
import * as language from '@codemirror/language';
import * as autocomplete from '@codemirror/autocomplete';
import * as common from '@lezer/common';
import * as highlight from '@lezer/highlight';
import * as lr from '@lezer/lr';
// The asset builder runs before TypeScript compilation.
// @ts-expect-error Build entry intentionally has no TypeScript declarations.
import { buildSyntax } from '../../scripts/build-syntax.mjs';

it('downloadable grammars share host CodeMirror instances and parse real Go/Web source', async () => {
  Object.defineProperty(globalThis, '__zwipSyntaxRuntime', {
    configurable: true,
    value: {
      '@codemirror/state': state,
      '@codemirror/view': view,
      '@codemirror/language': language,
      '@codemirror/autocomplete': autocomplete,
      '@lezer/common': common,
      '@lezer/highlight': highlight,
      '@lezer/lr': lr,
    },
  });
  for (const [name, extension, source, node] of [
    ['go', 'go', 'package main\nfunc main() {}', 'FunctionDecl'],
    ['web', 'ts', 'export class Worker { run(): void {} }', 'ClassDeclaration'],
    ['web', 'html', '<h1 class="title">Hello</h1>', 'Element'],
  ]) {
    const directory = await mkdtemp(join(tmpdir(), 'zwip-syntax-'));
    try {
      await buildSyntax(resolve('packages', name, 'syntax.ts'), directory);
      const factory = await import(pathToFileURL(join(directory, 'syntax.mjs')).href);
      const editor = state.EditorState.create({
        doc: source,
        extensions: [factory.createSyntax(extension)],
      });
      const tree = language.ensureSyntaxTree(editor, source.length, 1000);
      expect(tree?.toString()).toContain(node);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}, 15000);

it('the Makefile package grammar marks directives, targets, variables and recipes', async () => {
  Object.defineProperty(globalThis, '__zwipSyntaxRuntime', {
    configurable: true,
    value: {
      '@codemirror/state': state,
      '@codemirror/view': view,
      '@codemirror/language': language,
      '@codemirror/autocomplete': autocomplete,
      '@lezer/common': common,
      '@lezer/highlight': highlight,
      '@lezer/lr': lr,
    },
  });
  const directory = await mkdtemp(join(tmpdir(), 'zwip-syntax-'));
  try {
    await buildSyntax(resolve('packages/make/syntax.ts'), directory);
    const factory = await import(pathToFileURL(join(directory, 'syntax.mjs')).href);
    const source = [
      '# Build everything',
      'GO ?= go',
      'include common.mk',
      '.PHONY: build',
      'build: deps',
      '\t@$(GO) build -o "bin/$@" ./...',
      'ifeq ($(CI),true)',
      'endif',
    ].join('\n');
    const editor = state.EditorState.create({ doc: source, extensions: [factory.createSyntax()] });
    const tokens: string[] = [];
    highlight.highlightTree(
      language.ensureSyntaxTree(editor, source.length, 1000)!,
      { style: (tags) => tags.map((tag) => String(tag)).join(' ') },
      (from, to, classes) => tokens.push(`${source.slice(from, to)}=${classes}`),
    );
    const of = (text: string) => tokens.find((token) => token.startsWith(`${text}=`));
    expect(of('# Build everything')).toContain('comment');
    expect(of('include')).toContain('keyword');
    expect(of('ifeq')).toContain('keyword');
    expect(of('.PHONY')).toContain('keyword');
    expect(of('build')).toContain('definition');
    expect(of('?=')).toContain('operator');
    expect(tokens.some((token) => token.startsWith('$(GO)') || token.startsWith('$('))).toBe(true);
    expect(of('"bin/')).toContain('string');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
