import { Client, utils, type ConnectConfig, type SFTPWrapper, type Stats } from 'ssh2';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { posix, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import type {
  DeploymentRemoteEntry,
  DeploymentServer,
} from '../../../../src/model/deployment-contracts';
import { hasControl, limits, relativePath } from './paths';

export const hostFingerprint = (key: Buffer) =>
  'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
export const missing = (error: unknown) => (error as { code?: number }).code === 2;
export const privateKeyPath = (path: string) =>
  path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path;
export const cancelled = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new Error('Upload cancelled.');
};
export function remoteInside(root: string, path: string) {
  return path === root || path.startsWith(root.replace(/\/$/, '') + '/');
}
function safeError(error: unknown, secret?: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(secret ? message.split(secret).join('[credential]') : message);
}
export async function probeHost(
  server: DeploymentServer,
): Promise<{ fingerprint: string; algorithm: string }> {
  const client = new Client();
  return new Promise((accept, reject) => {
    let observed: { fingerprint: string; algorithm: string } | undefined;
    client.on('error', (error) => {
      client.destroy();
      if (observed) accept(observed);
      else reject(safeError(error));
    });
    client.once('close', () => {
      if (observed) accept(observed);
      else reject(new Error('Connection closed before receiving a server key.'));
    });
    client.connect({
      host: server.host,
      port: server.port,
      username: server.username,
      readyTimeout: 15_000,
      hostVerifier: (key: Buffer) => {
        const parsed = utils.parseKey(key);
        observed = {
          fingerprint: hostFingerprint(key),
          algorithm: parsed instanceof Error ? 'SSH host key' : parsed.type,
        };
        return false;
      },
    });
  });
}
export async function connect(
  server: DeploymentServer,
  secret: string | undefined,
  signal?: AbortSignal,
): Promise<RemoteSession> {
  cancelled(signal);
  const client = new Client();
  const config: ConnectConfig = {
    host: server.host,
    port: server.port,
    username: server.username,
    readyTimeout: 20_000,
    keepaliveInterval: 10_000,
    keepaliveCountMax: 3,
    hostVerifier: (key: Buffer) => hostFingerprint(key) === server.fingerprint,
  };
  if (server.auth === 'password') {
    if (!secret) throw new Error('Enter a password or save it in Keychain first.');
    config.password = secret;
  } else if (server.auth === 'key') {
    const path = privateKeyPath(server.keyPath);
    const info = await stat(path);
    if (!info.isFile() || info.size > limits.text)
      throw new Error('Private key must be a regular file smaller than 1 MiB.');
    config.privateKey = await readFile(path);
    if (secret) config.passphrase = secret;
  } else {
    if (!process.env.SSH_AUTH_SOCK)
      throw new Error('No SSH agent is available. Start an agent or choose a private key.');
    config.agent = process.env.SSH_AUTH_SOCK;
  }
  const abort = () => client.destroy();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const sftp = await new Promise<SFTPWrapper>((accept, reject) => {
      client.on('error', (error) => reject(safeError(error, secret)));
      client.once('close', () =>
        reject(new Error(signal?.aborted ? 'Upload cancelled.' : 'SSH connection closed.')),
      );
      client.once('ready', () =>
        client.sftp((error, channel) =>
          error ? reject(safeError(error, secret)) : accept(channel),
        ),
      );
      client.connect(config);
    });
    const remote = new RemoteSession(client, sftp);
    remote.root = await remote.realpath(server.root);
    const info = await remote.lstat(remote.root);
    if (!info?.isDirectory()) throw new Error('Remote root is not a directory.');
    return remote;
  } catch (error) {
    client.destroy();
    throw safeError(error, secret);
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
export interface RemoteIdentity {
  hash: string;
  bytes: number;
  mode: number;
}
export class RemoteSession {
  root = '';
  private closed = false;
  private staged = new Map<string, Buffer>();
  constructor(
    private client: Client,
    private sftp: SFTPWrapper,
  ) {
    client.once('close', () => {
      this.closed = true;
    });
    sftp.once('close', () => {
      this.closed = true;
      client.destroy();
    });
  }
  close() {
    this.client.destroy();
  }
  call<T>(
    operation: (done: (error: Error | undefined | null, value: T) => void) => void,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error('SFTP connection is closed.'));
    return new Promise((accept, reject) => {
      const close = () =>
        done(
          new Error('SFTP connection closed; operation outcome may be unknown.'),
          undefined as T,
        );
      const timer = setTimeout(() => {
        done(
          new Error('SFTP operation timed out; operation outcome may be unknown.'),
          undefined as T,
        );
        this.close();
      }, 30_000);
      const done = (error: Error | undefined | null, value: T) => {
        clearTimeout(timer);
        this.client.off('close', close);
        if (error) reject(error);
        else accept(value);
      };
      this.client.once('close', close);
      try {
        operation(done);
      } catch (error) {
        done(error as Error, undefined as T);
      }
    });
  }
  realpath(path: string) {
    return this.call<string>((done) => this.sftp.realpath(path, done));
  }
  async lstat(path: string): Promise<Stats | null> {
    try {
      return await this.call<Stats>((done) => this.sftp.lstat(path, done));
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
  async checked(relative: string, createParents = false, directoryMode = ''): Promise<string> {
    const path = relativePath(relative, true);
    const root = await this.lstat(this.root);
    if (!root?.isDirectory() || root.isSymbolicLink())
      throw new Error('Remote root changed. Reconnect and review it.');
    const parts = path.split('/').filter(Boolean);
    let current = this.root;
    for (let i = 0; i < parts.length; i++) {
      current = posix.join(current, parts[i]);
      let info = await this.lstat(current);
      if (!info && createParents && i < parts.length - 1) {
        try {
          await this.call<void>((done) =>
            this.sftp.mkdir(
              current,
              { mode: directoryMode ? parseInt(directoryMode, 8) : 0o755 },
              done,
            ),
          );
        } catch (error) {
          if (!(await this.lstat(current))?.isDirectory()) throw error;
        }
        info = await this.lstat(current);
      }
      if (info?.isSymbolicLink() || (info && i < parts.length - 1 && !info.isDirectory()))
        throw new Error('Remote symlinks and non-directory ancestors are not followed.');
      if (info && !remoteInside(this.root, await this.realpath(current)))
        throw new Error('Remote path escapes its configured root.');
    }
    return current;
  }
  async list(path: string): Promise<DeploymentRemoteEntry[]> {
    const full = await this.checked(path);
    const handle = await this.call<Buffer>((done) => this.sftp.opendir(full, done));
    const rows: import('ssh2').FileEntryWithStats[] = [];
    try {
      for (;;) {
        let batch: import('ssh2').FileEntryWithStats[] | false;
        try {
          batch = await this.call<import('ssh2').FileEntryWithStats[] | false>((done) =>
            this.sftp.readdir(handle, done),
          );
        } catch (error) {
          if ((error as { code?: number }).code === 1) break;
          throw error;
        }
        if (batch === false) break;
        if (!batch.length)
          throw new Error('Remote directory listing ended without an EOF acknowledgement.');
        rows.push(...batch);
        if (rows.length > limits.files)
          throw new Error('This remote directory contains more than 5000 entries.');
      }
    } finally {
      await this.call<void>((done) => this.sftp.close(handle, done)).catch(() => {});
    }
    return rows
      .filter(
        (row) =>
          row.filename !== '.' &&
          row.filename !== '..' &&
          !hasControl(row.filename) &&
          !row.filename.includes('/') &&
          !row.filename.includes('\\'),
      )
      .map((row) => ({
        name: row.filename,
        path: [path, row.filename].filter(Boolean).join('/'),
        kind: row.attrs.isSymbolicLink()
          ? ('link' as const)
          : row.attrs.isDirectory()
            ? ('directory' as const)
            : row.attrs.isFile()
              ? ('file' as const)
              : ('other' as const),
        bytes: row.attrs.size,
        modified: row.attrs.mtime * 1000,
      }))
      .sort(
        (a, b) =>
          Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
          a.name.localeCompare(b.name),
      );
  }
  async read(
    path: string,
    signal?: AbortSignal,
    retainText = false,
  ): Promise<(RemoteIdentity & { text?: string }) | null> {
    cancelled(signal);
    const full = await this.checked(path);
    const info = await this.lstat(full);
    if (!info) return null;
    if (!info.isFile()) throw new Error('Remote destination is not a regular file.');
    const maximum = retainText ? limits.text : limits.bytes;
    if (info.size > maximum)
      throw new Error(
        `Remote file exceeds the ${retainText ? '1 MiB comparison' : '1 GiB transfer'} limit.`,
      );
    const handle = await this.call<Buffer>((done) => this.sftp.open(full, 'r', done));
    const chunks: Buffer[] = [];
    const hash = createHash('sha256');
    let bytes = 0;
    const stream = this.sftp.createReadStream(full, { handle, autoClose: false });
    const abort = () => stream.destroy(new Error('Upload cancelled.'));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => stream.destroy(new Error('Remote file read timed out.')),
      60_000,
    );
    try {
      for await (const data of stream) {
        cancelled(signal);
        const chunk = Buffer.from(data);
        bytes += chunk.length;
        if (bytes > maximum) throw new Error('Remote file grew beyond the read limit.');
        hash.update(chunk);
        if (retainText) chunks.push(chunk);
      }
      const after = await this.call<Stats>((done) => this.sftp.fstat(handle, done));
      if (info.size !== bytes || after.size !== info.size || after.mtime !== info.mtime)
        throw new Error('Remote file changed while reading. Preview again.');
      return {
        hash: hash.digest('hex'),
        bytes,
        mode: info.mode,
        ...(retainText ? { text: Buffer.concat(chunks).toString('utf8') } : {}),
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      stream.destroy();
      await this.call<void>((done) => this.sftp.close(handle, done)).catch(() => {});
    }
  }
  async stage(
    snapshot: string,
    target: string,
    server: DeploymentServer,
    signal: AbortSignal,
    progress: (bytes: number) => void,
  ): Promise<string> {
    const full = await this.checked(target, true, server.directoryMode);
    const temporary = posix.join(posix.dirname(full), '.zwip-upload-' + randomUUID());
    const handle = await this.call<Buffer>((done) => this.sftp.open(temporary, 'wx', 0o600, done));
    this.staged.set(temporary, handle);
    try {
      const initial = await this.call<Stats>((done) => this.sftp.fstat(handle, done));
      if (!initial.isFile() || (initial.mode & 0o077) !== 0)
        throw new Error('Server did not create a private temporary upload file.');
      const input = createReadStream(snapshot);
      let sent = 0;
      let progressAt = Date.now();
      const idle = new AbortController();
      const watchdog = setInterval(() => {
        if (Date.now() - progressAt > 30_000) idle.abort();
      }, 5000);
      input.on('data', (chunk) => {
        sent += chunk.length;
        progressAt = Date.now();
        progress(sent);
      });
      try {
        await pipeline(
          input,
          this.sftp.createWriteStream(temporary, { handle, autoClose: false }),
          { signal: AbortSignal.any([signal, idle.signal]) },
        );
      } finally {
        clearInterval(watchdog);
      }
      const uploaded = await this.call<Stats>((done) => this.sftp.fstat(handle, done));
      if (!uploaded?.isFile() || uploaded.size !== sent)
        throw new Error('Staged upload size could not be verified.');
      return temporary;
    } catch (error) {
      await this.closeStaged(temporary).catch(() => {});
      await this.removeTemporary(temporary).catch(() => {});
      throw error;
    }
  }
  async publish(temporary: string, target: string, replacing: boolean, signal?: AbortSignal) {
    const full = await this.checked(target);
    if (
      !remoteInside(this.root, temporary) ||
      !posix.basename(temporary).startsWith('.zwip-upload-')
    )
      throw new Error('Invalid temporary upload identity.');
    cancelled(signal);
    let sent = false;
    try {
      await this.call<void>((done) => {
        if (replacing) this.sftp.ext_openssh_rename(temporary, full, done);
        else this.sftp.rename(temporary, full, done);
        sent = true;
      });
    } catch (error) {
      Object.assign(error as Error, { publicationStarted: sent });
      throw error;
    }
  }
  async metadata(
    temporary: string,
    server: DeploymentServer,
    existingMode: number | undefined,
    mtime: number,
  ) {
    const handle = this.staged.get(temporary);
    if (!handle) throw new Error('Uploaded file handle is no longer available.');
    const mode = server.fileMode
      ? parseInt(server.fileMode, 8)
      : existingMode === undefined
        ? 0o644
        : existingMode & 0o777;
    await this.call<void>((done) =>
      this.sftp.fsetstat(
        handle,
        {
          mode,
          ...(server.preserveTimestamps
            ? { atime: Math.floor(mtime / 1000), mtime: Math.floor(mtime / 1000) }
            : {}),
        },
        done,
      ),
    );
  }
  async closeStaged(temporary: string) {
    const handle = this.staged.get(temporary);
    this.staged.delete(temporary);
    if (handle) await this.call<void>((done) => this.sftp.close(handle, done));
  }
  async removeTemporary(path: string) {
    if (!remoteInside(this.root, path) || !/^\.zwip-upload-[a-f0-9-]+$/.test(posix.basename(path)))
      throw new Error('Invalid temporary upload identity.');
    await this.closeStaged(path);
    await this.checked(posix.relative(this.root, posix.dirname(path)));
    await this.call<void>((done) => this.sftp.unlink(path, done));
  }
}
