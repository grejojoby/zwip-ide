import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { RemoteSession } from '../../packages/tools/src/deployment/transport';
import { DeploymentService } from '../../packages/tools/src/deployment/service';
import {
  newDeploymentServer,
  type DeploymentJob,
  type DeploymentPlan,
  type DeploymentSettings,
} from '../../src/model/deployment-contracts';
import { sftpFixture } from './sftp-fixture';
let fixture: Awaited<ReturnType<typeof sftpFixture>>;
let directory: string, workspace: string, remote: string, cache: string;
let service: DeploymentService, settings: DeploymentSettings;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
beforeAll(async () => {
  fixture = await sftpFixture();
});
afterAll(async () => {
  await fixture?.close();
});
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'zwip-deploy-service-')));
  workspace = join(directory, 'workspace');
  remote = join(directory, 'remote');
  cache = join(directory, 'cache');
  await mkdir(workspace);
  await mkdir(remote);
  await writeFile(join(workspace, 'index.html'), 'saved source');
  service = new DeploymentService(workspace, cache);
  settings = await request('settings.save', {
    expectedRevision: 0,
    settings: {
      revision: 0,
      servers: [
        {
          ...newDeploymentServer('server'),
          name: 'Local SFTP',
          host: '127.0.0.1',
          port: fixture.port,
          username: 'fixture',
          auth: 'password',
          fingerprint: fixture.fingerprint,
          root: remote,
        },
      ],
      defaultId: 'server',
      autoUpload: 'never',
    },
    sessionSecret: { serverId: 'server', secret: 'fixture-password' },
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await service.dispose();
  await rm(directory, { recursive: true, force: true });
});
it('reports a lost rename acknowledgement as unknown and keeps that outcome after reopening', async () => {
  await upload(await plan());
  await writeFile(join(workspace, 'index.html'), 'published but acknowledgement lost');
  const preview = await plan();
  fixture.dropNextRenameReply();
  const job = await upload(preview);
  expect(job.files[0].status).toBe('unknown');
  expect(await readFile(join(remote, 'index.html'), 'utf8')).toBe(
    'published but acknowledgement lost',
  );
  await service.dispose();
  service = new DeploymentService(workspace, cache);
  expect((await request<DeploymentJob>('transfer.status')).files[0].status).toBe('unknown');
});
it('redacts server-echoed credentials before preview responses or transfer journals', async () => {
  const read = vi
    .spyOn(RemoteSession.prototype, 'read')
    .mockRejectedValue(new Error('Server echoed fixture-password'));
  const preview = await plan();
  expect(preview.files[0].reason).toContain('[credential]');
  expect(JSON.stringify(preview)).not.toContain('fixture-password');
  read.mockRestore();
  const next = await plan();
  vi.spyOn(RemoteSession.prototype, 'stage').mockRejectedValue(
    new Error('Upload echoed fixture-password'),
  );
  const job = await upload(next);
  expect(job.files[0].message).toContain('[credential]');
  const [state] = await readdir(cache);
  expect(await readFile(join(cache, state, 'transfer.json'), 'utf8')).not.toContain(
    'fixture-password',
  );
});
it('excludes the configured private key after expanding its tilde path', async () => {
  const key = join(workspace, 'deploy_id');
  await writeFile(key, fixture.key);
  settings.servers[0].auth = 'key';
  settings.servers[0].keyPath = '~/' + relative(homedir(), key);
  settings = await request('settings.save', { expectedRevision: settings.revision, settings });
  expect((await plan()).files.map((file) => file.local)).toEqual(['index.html']);
});
async function request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return service.dispatch(method, {
    workspaceRoot: workspace,
    serverId: 'server',
    ...params,
  }) as Promise<T>;
}
async function plan(paths = ['.']) {
  return request<DeploymentPlan>('upload.plan', { paths });
}
async function upload(plan: DeploymentPlan) {
  await request('upload.start', {
    planId: plan.id,
    keys: plan.files.filter((file) => file.action !== 'blocked').map((file) => file.key),
  });
  return finished();
}
async function finished() {
  for (let i = 0; i < 500; i++) {
    const job = await request<DeploymentJob>('transfer.status');
    if (job.status !== 'running') return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Transfer did not finish.');
}
it('previews without writes, uploads snapshots, skips unchanged content and preserves restrictive permissions', async () => {
  await writeFile(join(workspace, '.env'), 'never upload');
  await symlink(join(workspace, 'index.html'), join(workspace, 'link.html'));
  const preview = await plan();
  expect(await readdir(remote)).toEqual([]);
  expect(preview.files.map((file) => file.local)).toEqual(['index.html']);
  expect((await upload(preview)).status).toBe('completed');
  expect(await readFile(join(remote, 'index.html'), 'utf8')).toBe('saved source');
  expect((await plan()).files[0].action).toBe('unchanged');
  await writeFile(join(remote, 'index.html'), 'saved source', { mode: 0o600 });
  const { chmod } = await import('node:fs/promises');
  await chmod(join(remote, 'index.html'), 0o600);
  await writeFile(join(workspace, 'index.html'), 'next saved source');
  expect((await upload(await plan())).files[0].status).toBe('uploaded');
  expect((await stat(join(remote, 'index.html'))).mode & 0o777).toBe(0o600);
});
it('rejects changed local and remote content after preview without replacing either destination', async () => {
  await upload(await plan());
  await writeFile(join(workspace, 'index.html'), 'new source');
  let preview = await plan();
  await writeFile(join(workspace, 'index.html'), 'changed after preview');
  expect((await upload(preview)).files[0].status).toBe('failed');
  expect(await readFile(join(remote, 'index.html'), 'utf8')).toBe('saved source');
  preview = await plan();
  await writeFile(join(remote, 'index.html'), 'remote editor changed this');
  expect((await upload(preview)).files[0].message).toMatch(/remote file changed/i);
  expect(await readFile(join(remote, 'index.html'), 'utf8')).toBe('remote editor changed this');
  expect((await plan()).files[0].action).toBe('conflict');
  expect((await readdir(remote)).filter((file) => file.startsWith('.zwip-upload-'))).toEqual([]);
});
it('applies configured file/directory permissions and preserves timestamps', async () => {
  const timestamp = new Date('2025-01-02T03:04:05Z');
  await utimes(join(workspace, 'index.html'), timestamp, timestamp);
  settings.servers[0] = {
    ...settings.servers[0],
    mappings: [{ local: '.', remote: 'site' }],
    fileMode: '640',
    directoryMode: '750',
    preserveTimestamps: true,
  };
  settings = await request('settings.save', { expectedRevision: settings.revision, settings });
  expect((await upload(await plan())).status).toBe('completed');
  const file = await stat(join(remote, 'site/index.html'));
  expect(file.mode & 0o777).toBe(0o640);
  expect(Math.abs(file.mtimeMs - timestamp.getTime())).toBeLessThan(1000);
  expect((await stat(join(remote, 'site'))).mode & 0o777).toBe(0o750);
});
it('retains successful uploads when another file fails its content precondition', async () => {
  await writeFile(join(workspace, 'other.html'), 'other saved file');
  const preview = await plan();
  await writeFile(join(workspace, 'index.html'), 'changed after review');
  const job = await upload(preview);
  expect(job.status).toBe('partial');
  expect(job.files.find((file) => file.local === 'index.html')?.status).toBe('failed');
  expect(job.files.find((file) => file.local === 'other.html')?.status).toBe('uploaded');
  expect(await readFile(join(remote, 'other.html'), 'utf8')).toBe('other saved file');
});
it('binds automatic upload to acknowledged saved bytes and requires review for unknown remote changes', async () => {
  settings = await request('settings.save', {
    expectedRevision: settings.revision,
    settings: { ...settings, autoUpload: 'onSave' },
  });
  const saved = [
    {
      path: join(workspace, 'index.html'),
      hash: hash('saved source'),
      revision: 1,
      workspaceGeneration: 1,
    },
  ];
  await writeFile(join(workspace, 'index.html'), 'external checkout');
  expect(await request('upload.auto', { saved })).toMatchObject({
    conflicts: 1,
    message: expect.stringContaining('acknowledged IDE save'),
  });
  expect(await readdir(remote)).toEqual([]);
  await writeFile(join(workspace, 'index.html'), 'saved source');
  await writeFile(join(remote, 'index.html'), 'unrecognized server version');
  expect(await request('upload.auto', { saved })).toMatchObject({ conflicts: 1 });
  await upload(await plan());
  await writeFile(join(workspace, 'index.html'), 'next IDE save');
  expect(
    await request('upload.auto', {
      saved: [{ ...saved[0], hash: hash('next IDE save'), revision: 2 }],
    }),
  ).toHaveProperty('job');
  expect((await finished()).status).toBe('completed');
  expect(await readFile(join(remote, 'index.html'), 'utf8')).toBe('next IDE save');
});
it('keeps credentials out of stored settings, invalidates stale plans and isolates workspace callbacks', async () => {
  const preview = await plan();
  await expect(request('settings.save', { expectedRevision: 0, settings })).rejects.toThrow(
    /changed/i,
  );
  settings = await request('settings.save', { expectedRevision: settings.revision, settings });
  await expect(upload(preview)).rejects.toThrow(/preview/i);
  await expect(service.dispatch('settings.get', { workspaceRoot: remote })).rejects.toThrow(
    /workspace changed/i,
  );
  const files = await readdir(cache);
  const text = await readFile(join(cache, files[0], 'settings.json'), 'utf8');
  expect(text).not.toContain('fixture-password');
});
it('cancels a queued transfer and retains no temporary remote files', async () => {
  const preview = await plan();
  const job = await request<DeploymentJob>('upload.start', {
    planId: preview.id,
    keys: preview.files.map((file) => file.key),
  });
  await request('transfer.cancel', { id: job.id });
  expect((await finished()).status).toBe('cancelled');
  expect(await readdir(remote)).toEqual([]);
});
it('recovers from an initial journal write failure without losing the reviewed plan', async () => {
  const preview = await plan();
  const [state] = await readdir(cache);
  const journal = join(cache, state, 'transfer.json');
  await mkdir(journal);
  await expect(upload(preview)).rejects.toThrow();
  expect(await request('transfer.status')).toBeNull();
  await rm(journal, { recursive: true });
  expect((await upload(preview)).status).toBe('completed');
});
it('rejects remote symlink ancestors and destination collisions', async () => {
  await mkdir(join(workspace, 'one'));
  await mkdir(join(workspace, 'two'));
  await writeFile(join(workspace, 'one/same.txt'), 'one');
  await writeFile(join(workspace, 'two/same.txt'), 'two');
  settings.servers[0].mappings = [
    { local: 'one', remote: 'mapped' },
    { local: 'two', remote: 'mapped' },
  ];
  settings = await request('settings.save', { expectedRevision: settings.revision, settings });
  await expect(plan(['one', 'two'])).rejects.toThrow(/same remote/i);
  await symlink(workspace, join(remote, 'mapped'));
  const preview = await plan(['one']);
  expect(preview.files[0]).toMatchObject({
    action: 'blocked',
    reason: expect.stringMatching(/symlink/i),
  });
});
