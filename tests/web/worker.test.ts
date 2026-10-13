import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { startWorker } from '../../packages/web/src/worker';

describe('Web package JSONL transport', () => {
  it('starts the bundled worker through a symlinked installation directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zwip-web-entry-'));
    try {
      const actual = join(directory, 'installed');
      const alias = join(directory, 'linked-install');
      await mkdir(actual);
      await symlink(actual, alias, 'dir');
      await build({
        entryPoints: [resolve('packages/web/src/worker.ts')],
        outfile: join(actual, 'worker.mjs'),
        platform: 'node',
        format: 'esm',
        mainFields: ['module', 'main'],
        bundle: true,
        target: 'node22',
        banner: {
          js: "import { createRequire as __nodeCreateRequire } from 'node:module'; const require = __nodeCreateRequire(import.meta.url);",
        },
      });
      const launched = spawnSync(process.execPath, [join(alias, 'worker.mjs')], {
        input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'workspace.status' })}\n`,
        encoding: 'utf8',
        timeout: 5000,
      });
      expect(launched.error).toBeUndefined();
      expect(launched.status, launched.stderr).toBe(0);
      expect(launched.stdout.trim()).not.toBe('');
      expect(JSON.parse(launched.stdout)).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: { generation: -1, contexts: [] },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('returns protocol errors without corrupting subsequent requests', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let wire = '';
    output.on('data', (chunk) => {
      wire += chunk.toString();
    });
    const worker = startWorker(input, output);
    input.write('invalid json\n');
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'missing' })}\n`);
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'navigation.query', params: {} })}\n`,
    );
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'shutdown' })}\n`);
    await worker.done();
    const responses = wire
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(responses).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } },
      { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Unknown method: missing' } },
      { jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'Invalid navigation query.' } },
      { jsonrpc: '2.0', id: 3, result: null },
    ]);
  });

  it('uses the RPC id independently of the semantic query id', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let wire = '';
    output.on('data', (chunk) => {
      wire += chunk.toString();
    });
    const worker = startWorker(input, output);
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'navigation.query', params: { id: 'semantic-identity', operation: 'definition', path: '/tmp/a.ts', position: { line: 0, character: 0 }, documentRevision: 0, workspaceGeneration: 20 } })}\n`,
    );
    await worker.done();
    const response = JSON.parse(wire.trim());
    expect(response.id).toBe(77);
    expect(response.result.id).toBe('semantic-identity');
    expect(response.result.state).toBe('failed');
    worker.dispose();
  });
});

it('serves workspace symbol requests without requiring an open document', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let wire = '';
  output.on('data', (chunk) => {
    wire += chunk.toString();
  });
  const worker = startWorker(input, output);
  input.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { root: '/tmp', generation: 1, contexts: [] } })}\n`,
  );
  input.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'workspace.symbols', params: { id: 'symbols-no-tab', query: 'work', workspaceGeneration: 1 } })}\n`,
  );
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'workspace.status' })}\n`);
  await worker.done();
  const responses = wire
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const response = responses[1];
  expect(response.id).toBe(2);
  expect(response.result.id).toBe('symbols-no-tab');
  expect(response.result.documentRevision).toBe(0);
  expect(response.result.state).toBe('failed');
  expect(response.result.reasons).toContain('No configured web projects are available.');
  expect(responses[2]).toEqual({ jsonrpc: '2.0', id: 3, result: { generation: 1, contexts: [] } });
  worker.dispose();
});
