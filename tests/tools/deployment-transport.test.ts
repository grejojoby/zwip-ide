import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sftpFixture } from './sftp-fixture';
import { connect, probeHost } from '../../packages/tools/src/deployment/transport';
import { newDeploymentServer, type DeploymentServer } from '../../src/model/deployment-contracts';
let fixture: Awaited<ReturnType<typeof sftpFixture>>;
let directory: string;
let server: DeploymentServer;
beforeAll(async () => {
  fixture = await sftpFixture();
  directory = await mkdtemp(join(tmpdir(), 'zwip-sftp-'));
  server = {
    ...newDeploymentServer('server'),
    name: 'Fixture',
    host: '127.0.0.1',
    port: fixture.port,
    username: 'fixture',
    auth: 'password',
    root: directory,
    fingerprint: fixture.fingerprint,
  };
});
afterAll(async () => {
  await fixture?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
it('probes without credentials and rejects an untrusted or changed host key before authentication', async () => {
  const before = fixture.authenticated();
  expect((await probeHost(server)).fingerprint).toBe(server.fingerprint);
  expect(fixture.authenticated()).toBe(before);
  await expect(
    connect({ ...server, fingerprint: 'SHA256:' + 'b'.repeat(43) }, 'fixture-password'),
  ).rejects.toThrow();
  expect(fixture.authenticated()).toBe(before);
});
it('uploads private temporary bytes, publishes atomically, browses and reads through real SFTP', async () => {
  const remote = await connect(server, 'fixture-password');
  try {
    const source = join(directory, 'source.txt');
    await writeFile(source, 'hello');
    const staged = await remote.stage(
      source,
      'nested/target.txt',
      server,
      new AbortController().signal,
      () => {},
    );
    expect((await stat(staged)).mode & 0o777).toBe(0o600);
    await remote.publish(staged, 'nested/target.txt', false);
    await remote.metadata(staged, server, 0o600, Date.now());
    await remote.closeStaged(staged);
    expect(await readFile(join(directory, 'nested/target.txt'), 'utf8')).toBe('hello');
    expect((await remote.read('nested/target.txt', undefined, true))?.text).toBe('hello');
    expect((await remote.list('nested'))[0].name).toBe('target.txt');
    await writeFile(source, 'replacement');
    const replaced = await remote.stage(
      source,
      'nested/target.txt',
      server,
      new AbortController().signal,
      () => {},
    );
    await remote.publish(replaced, 'nested/target.txt', true);
    expect(await readFile(join(directory, 'nested/target.txt'), 'utf8')).toBe('replacement');
    await symlink(tmpdir(), join(directory, 'escape'));
    await expect(remote.checked('escape/anything')).rejects.toThrow(/symlink/i);
  } finally {
    remote.close();
  }
});
it('finalizes metadata on the uploaded handle without chmodding a concurrent replacement', async () => {
  const remote = await connect(server, 'fixture-password');
  try {
    const source = join(directory, 'metadata-source');
    await writeFile(source, 'uploaded');
    const temporary = await remote.stage(
      source,
      'metadata-target',
      server,
      new AbortController().signal,
      () => {},
    );
    await remote.publish(temporary, 'metadata-target', false);
    const replacement = join(directory, 'replacement');
    await writeFile(replacement, 'other writer', { mode: 0o600 });
    await rename(replacement, join(directory, 'metadata-target'));
    await remote.metadata(temporary, { ...server, fileMode: '644' }, undefined, Date.now());
    expect((await stat(join(directory, 'metadata-target'))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(directory, 'metadata-target'), 'utf8')).toBe('other writer');
    await remote.closeStaged(temporary);
  } finally {
    remote.close();
  }
});
it('supports an explicit private key and rejects bad passwords', async () => {
  const key = join(directory, 'id_ed25519');
  await writeFile(key, fixture.key, { mode: 0o600 });
  const remote = await connect({ ...server, auth: 'key', keyPath: key }, undefined);
  remote.close();
  await expect(connect(server, 'incorrect')).rejects.toThrow(/authentication/i);
});
it('does not publish when cancelled while validating the destination ancestry', async () => {
  const remote = await connect(server, 'fixture-password');
  try {
    const source = join(directory, 'cancel-source');
    await writeFile(source, 'not published');
    const controller = new AbortController();
    const staged = await remote.stage(source, 'cancel-target', server, controller.signal, () => {});
    const checked = remote.checked.bind(remote);
    remote.checked = async (...args) => {
      const path = await checked(...args);
      controller.abort();
      return path;
    };
    await expect(remote.publish(staged, 'cancel-target', false, controller.signal)).rejects.toThrow(
      /cancelled/i,
    );
    await expect(stat(join(directory, 'cancel-target'))).rejects.toThrow();
    remote.checked = checked;
    await remote.removeTemporary(staged);
  } finally {
    remote.close();
  }
});
