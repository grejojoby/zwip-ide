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
    ['go', 'go', 'package main\nfunc main() {}', 'keyword'],
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
