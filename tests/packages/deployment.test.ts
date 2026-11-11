import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { expect, it } from 'vitest';
import { newDeploymentServer } from '../../src/model/deployment-contracts';
import { sftpFixture } from '../tools/sftp-fixture';
const { buildToolsPackages } = await import(
  new URL('../../packages/tools/build.mjs', import.meta.url).href
);
it('builds a self-contained checksummed SFTP worker and uploads through its JSON-line contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zwip-deployment-package-'));
  const fixture = await sftpFixture();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const workspace = join(root, 'workspace'),
      remote = join(root, 'remote');
    await mkdir(workspace);
    await mkdir(remote);
    await writeFile(join(workspace, 'index.html'), '<h1>Packaged deployment</h1>');
    await buildToolsPackages({ outDir: join(root, 'packages'), ids: ['deployment'] });
    const output = join(root, 'packages/deployment');
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
    expect(manifest.languages).toEqual(['deployment']);
    expect(manifest.capabilities).toContain('uploadPreview');
    for (const [path, hash] of Object.entries(manifest.checksums))
      expect(
        createHash('sha256')
          .update(await readFile(join(output, path)))
          .digest('hex'),
      ).toBe(hash);
    expect(await readFile(join(output, 'THIRD-PARTY-NOTICES.txt'), 'utf8')).toContain(
      'ssh2@1.17.0',
    );
    child = spawn(join(output, manifest.executable), [join(output, manifest.args[0])], {
      cwd: workspace,
      env: { ...process.env, ZWIP_PACKAGE_CACHE: join(root, 'cache') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: child.stdout! });
    const iterator = lines[Symbol.asyncIterator]();
    let id = 0;
    const rpc = async (method: string, params: unknown) => {
      child!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n');
      const response = JSON.parse((await iterator.next()).value!);
      expect(response.id).toBe(id);
      expect(response.error).toBeUndefined();
      return response.result;
    };
    const tool = (method: string, params: Record<string, unknown> = {}) =>
      rpc('tool.request', {
        method,
        params: { workspaceRoot: workspace, serverId: 'server', ...params },
      });
    expect(await rpc('initialize', {})).toEqual({ ready: true });
    await tool('settings.save', {
      expectedRevision: 0,
      settings: {
        revision: 0,
        servers: [
          {
            ...newDeploymentServer('server'),
            name: 'Fixture',
            host: '127.0.0.1',
            port: fixture.port,
            username: 'fixture',
            auth: 'password',
            root: remote,
            fingerprint: fixture.fingerprint,
          },
        ],
        defaultId: 'server',
        autoUpload: 'never',
      },
      sessionSecret: { serverId: 'server', secret: 'fixture-password' },
    });
    const plan = await tool('upload.plan', { paths: ['.'] });
    await tool('upload.start', {
      planId: plan.id,
      keys: plan.files.map((file: { key: string }) => file.key),
    });
    let status;
    for (let i = 0; i < 200; i++) {
      status = await tool('transfer.status');
      if (status.status !== 'running') break;
      await new Promise((accept) => setTimeout(accept, 10));
    }
    expect(status.status).toBe('completed');
    expect(await readFile(join(remote, 'index.html'), 'utf8')).toContain('Packaged deployment');
    await rpc('shutdown', {});
    child.stdin!.end();
    lines.close();
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
