import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-expect-error Package builder runs before TypeScript compilation.
import { buildPhpPackage } from '../../packages/php/build.mjs';
it('builds a checksummed PHP add-on and serves overlays through its bundled runtime', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zwip-php-package-')));
  const out = realpathSync(mkdtempSync(join(tmpdir(), 'zwip-php-build-')));
  try {
    const path = join(root, 'main.php');
    writeFileSync(path, '<?php function greet() {}');
    await buildPhpPackage({ outDir: out });
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    expect(manifest.checksums['worker.mjs']).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.checksums['syntax.mjs']).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(join(out, 'runtime/LICENSE'), 'utf8')).toContain('Node.js');
    const messages = [
      {
        id: 1,
        method: 'initialize',
        params: {
          root,
          generation: 1,
          contexts: [{ id: 'main.php', root, configPath: path, language: 'php', state: 'loading' }],
          files: [{ path }],
        },
      },
      {
        id: 2,
        method: 'editor.request',
        params: {
          id: 'symbols',
          operation: 'symbols',
          path,
          documentRevision: 0,
          workspaceGeneration: 1,
        },
      },
      {
        id: 3,
        method: 'document.update',
        params: { path, content: '<?php function broken( {', revision: 1 },
      },
      {
        id: 4,
        method: 'editor.request',
        params: {
          id: 'errors',
          operation: 'diagnostics',
          path,
          documentRevision: 1,
          workspaceGeneration: 1,
        },
      },
      { id: 5, method: 'shutdown' },
    ];
    const child = spawnSync(
      join(out, manifest.executable),
      manifest.args.map((arg: string) => join(out, arg)),
      {
        cwd: root,
        input: messages.map((m) => JSON.stringify({ jsonrpc: '2.0', ...m })).join('\n') + '\n',
        encoding: 'utf8',
        timeout: 15000,
      },
    );
    expect(child.error?.message ?? child.stderr).toBe('');
    expect(child.status).toBe(0);
    const replies = child.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(replies[0].result.capabilities).toContain('diagnostics');
    expect(replies[1].result.symbols[0].name).toBe('greet');
    expect(replies[3].result.diagnostics[0].severity).toBe('error');
    expect(replies[4].result).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
}, 30000);
