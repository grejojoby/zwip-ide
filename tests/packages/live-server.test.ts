import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { expect, it } from 'vitest';
const { buildToolsPackages } = await import(
  new URL('../../packages/tools/build.mjs', import.meta.url).href
);

it('builds an independent checksummed worker and shuts down its running server on EOF', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zwip-live-package-'));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const outDir = join(root, 'packages');
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    await writeFile(join(workspace, 'index.html'), '<body>Packaged preview</body>');
    await buildToolsPackages({ outDir, ids: ['live-server'] });
    const output = join(outDir, 'live-server');
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
    expect(manifest.id).toBe('live-server');
    // Tool workers route through the host's provider ID, independently of document languages.
    expect(manifest.languages).toEqual(['live-server']);
    expect(manifest.capabilities).toEqual(['staticServer', 'liveReload']);
    for (const [path, digest] of Object.entries(manifest.checksums)) {
      expect(
        createHash('sha256')
          .update(await readFile(join(output, path)))
          .digest('hex'),
      ).toBe(digest);
    }
    expect(manifest.checksums['THIRD-PARTY-NOTICES.txt']).toBeTruthy();
    child = spawn(join(output, manifest.executable), [join(output, manifest.args[0])], {
      cwd: workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child!.once('exit', resolve);
      child!.once('error', reject);
    });
    const responses = createInterface({ input: child.stdout! });
    const iterator = responses[Symbol.asyncIterator]();
    let id = 0;
    async function rpc(method: string, params = {}) {
      child!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n');
      const response = JSON.parse((await iterator.next()).value!);
      expect(response.id).toBe(id);
      expect(response.error).toBeUndefined();
      return response.result;
    }
    expect(await rpc('initialize')).toEqual({ ready: true });
    expect(await rpc('tool.request', { method: 'status', params: {} })).toEqual({ running: false });
    const running = await rpc('tool.request', { method: 'start', params: { port: 0 } });
    expect(await (await fetch(running.url)).text()).toContain('Packaged preview');
    child.stdin!.end();
    expect(await exited).toBe(0);
    await expect(fetch(running.url)).rejects.toThrow();
    responses.close();
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});
