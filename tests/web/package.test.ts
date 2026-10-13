import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
// The package builder is JavaScript because it runs before the project typecheck.
// @ts-expect-error Build entry intentionally has no runtime TypeScript declarations.
import { buildWebPackage } from '../../packages/web/build.mjs';

it('runs editor requests through the bundled package runtime and fallback SDK', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zwip-web-package-')));
  const out = realpathSync(mkdtempSync(join(tmpdir(), 'zwip-web-package-build-')));
  try {
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] }),
    );
    writeFileSync(join(root, 'main.ts'), 'export const answer: number = 42;');
    writeFileSync(join(root, 'page.html'), '<div>value</div>');
    await buildWebPackage({ outDir: out });
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    expect(manifest.checksums['worker.mjs']).toMatch(/^[a-f0-9]{64}$/);
    const messages = [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          root,
          generation: 1,
          contexts: [
            {
              id: 'app',
              root,
              configPath: join(root, 'tsconfig.json'),
              language: 'web',
              state: 'loading',
            },
          ],
        },
      },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'editor.request',
        params: {
          id: 'hover',
          operation: 'hover',
          path: join(root, 'main.ts'),
          position: { line: 0, character: 15 },
          documentRevision: 0,
          workspaceGeneration: 1,
        },
      },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'editor.request',
        params: {
          id: 'html',
          operation: 'rename',
          path: join(root, 'page.html'),
          position: { line: 0, character: 2 },
          newName: 'section',
          documentRevision: 0,
          workspaceGeneration: 1,
        },
      },
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'workspace.changed',
        params: { paths: [join(root, 'main.ts')] },
      },
      { jsonrpc: '2.0', id: 5, method: 'shutdown' },
    ];
    const process = spawnSync(
      join(out, manifest.executable),
      manifest.args.map((arg: string) => join(out, arg)),
      {
        cwd: root,
        input: messages.map((message) => JSON.stringify(message)).join('\n') + '\n',
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      },
    );
    expect(process.error?.message ?? process.stderr).toBe('');
    expect(process.status).toBe(0);
    const replies = process.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(replies[0].result.contexts[0].sdkSource).toBe('fallback');
    expect(replies[1].result.hover).toContain('answer: number');
    expect(replies[2].result.edits).toHaveLength(2);
    expect(replies[3].result.workspaceGeneration).toBe(1);
    expect(replies[4].result).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
}, 30_000);
