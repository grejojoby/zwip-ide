import { lstat, mkdir, mkdtemp, opendir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  DeploymentFile,
  DeploymentJob,
  DeploymentPlan,
  DeploymentSavedFile,
  DeploymentServer,
  DeploymentSettings,
} from '../../../../src/model/deployment-contracts';
import { object, string, type Params } from '../transport';
import {
  destination,
  excluded,
  inside,
  limits,
  relativePath,
  validateServer,
  validateSettings,
} from './paths';
import { cancelled, connect, privateKeyPath, probeHost, type RemoteSession } from './transport';
import { digest, localContent, localText, readJson, writeJson } from './store';

const emptySettings = (): DeploymentSettings => ({
  revision: 0,
  servers: [],
  defaultId: '',
  autoUpload: 'never',
});
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const redacted = (error: unknown, secret?: string) =>
  secret ? message(error).split(secret).join('[credential]') : message(error);
export class DeploymentService {
  private root = '';
  private directory = '';
  private ready: Promise<void>;
  private settings = emptySettings();
  private baseline: Record<string, string> = {};
  private plans = new Map<string, DeploymentPlan>();
  private sessions = new Set<RemoteSession>();
  private secrets = new Map<string, string>();
  private job: DeploymentJob | null = null;
  private controller?: AbortController;
  private running?: Promise<void>;
  private disposed = false;
  private saving = false;
  constructor(
    workspace = process.cwd(),
    cache = process.env.ZWIP_PACKAGE_CACHE ?? join(tmpdir(), 'zwip-deployment'),
  ) {
    this.ready = (async () => {
      this.root = await realpath(workspace);
      this.directory = join(cache, digest(this.root));
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const stored = await readJson(join(this.directory, 'settings.json'), emptySettings());
      if (!Number.isSafeInteger(stored.revision) || stored.revision < 0)
        throw new Error('Stored deployment revision is invalid.');
      this.settings = { ...validateSettings(stored), revision: stored.revision };
      this.baseline = await readJson(join(this.directory, 'baseline.json'), {});
      this.job = await readJson<DeploymentJob | null>(join(this.directory, 'transfer.json'), null);
      if (this.job?.status === 'running') {
        this.job.status = 'interrupted';
        this.job.finishedAt = Date.now();
        for (const file of this.job.files) {
          if (file.status === 'publishing') {
            file.status = 'unknown';
            file.message = 'Interrupted while publishing. Compare the remote file before retrying.';
          } else if (file.status === 'uploading' || file.status === 'queued') {
            file.status = 'cancelled';
            file.message = 'Worker stopped before publication.';
          }
        }
        await this.journal();
      }
    })();
    // Initialization errors are returned by dispatch; keep the owned promise handled until then.
    void this.ready.catch(() => {});
  }
  async dispatch(method: string, params: Params): Promise<unknown> {
    await this.ready;
    if (this.disposed) throw new Error('Deployment worker is stopping.');
    if (
      typeof params.workspaceRoot !== 'string' ||
      (await realpath(params.workspaceRoot)) !== this.root
    )
      throw new Error('Workspace changed. Reopen Deployment.');
    switch (method) {
      case 'settings.get':
        return this.settings;
      case 'settings.save':
        return this.save(params);
      case 'host.probe':
        return probeHost(validateServer(params.server, false));
      case 'connection.test': {
        const server = validateServer(params.server);
        return this.withRemote(server, params, async (remote) => ({
          root: remote.root,
          message: 'SFTP connection succeeded.',
        }));
      }
      case 'remote.list': {
        const server = this.server(params);
        return this.withRemote(server, params, async (remote) => ({
          root: remote.root,
          entries: await remote.list(relativePath(string(params, 'path'), true)),
        }));
      }
      case 'upload.plan':
        return this.plan(this.server(params), params);
      case 'upload.start':
        return this.start(params);
      case 'upload.auto':
        return this.automatic(params);
      case 'transfer.status':
        return this.job;
      case 'transfer.cancel': {
        if (this.job?.id !== params.id) throw new Error('Transfer is no longer active.');
        this.controller?.abort();
        return this.job;
      }
      case 'remote.compare':
        return this.compare(params);
      default:
        throw new Error('Unsupported deployment operation.');
    }
  }
  private server(params: Params): DeploymentServer {
    const server = this.settings.servers.find((item) => item.id === params.serverId);
    if (!server) throw new Error('Deployment server no longer exists.');
    return server;
  }
  private identity(server: DeploymentServer) {
    return digest(
      JSON.stringify([server.host, server.port, server.username, server.auth, server.keyPath]),
    );
  }
  private credential(server: DeploymentServer, params: Params) {
    const secret =
      typeof params.secret === 'string'
        ? params.secret
        : typeof params.credential === 'string'
          ? params.credential
          : this.secrets.get(this.identity(server));
    if (typeof params.secret === 'string') this.secrets.set(this.identity(server), params.secret);
    return secret;
  }
  private async withRemote<T>(
    server: DeploymentServer,
    params: Params,
    operation: (remote: RemoteSession) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const secret = this.credential(server, params);
    const remote = await connect(server, secret, signal);
    if (this.disposed) {
      remote.close();
      throw new Error('Deployment worker stopped.');
    }
    this.sessions.add(remote);
    try {
      return await operation(remote);
    } catch (error) {
      throw new Error(redacted(error, secret), { cause: error });
    } finally {
      this.sessions.delete(remote);
      remote.close();
    }
  }
  private async save(params: Params) {
    if (this.saving || this.job?.status === 'running')
      throw new Error('Wait for the active operation before changing deployment settings.');
    if (params.expectedRevision !== this.settings.revision)
      throw new Error('Deployment settings changed. Reload before saving.');
    this.saving = true;
    try {
      const next = { ...validateSettings(params.settings), revision: this.settings.revision + 1 };
      await writeJson(this.directory, 'settings.json', next);
      this.settings = next;
      this.plans.clear();
      if (params.sessionSecret) {
        const item = object(params.sessionSecret);
        const server = next.servers.find((server) => server.id === item.serverId);
        if (server && typeof item.secret === 'string')
          this.secrets.set(this.identity(server), item.secret);
      }
      return this.settings;
    } finally {
      this.saving = false;
    }
  }
  private async local(path: string): Promise<string> {
    const absolute = isAbsolute(path) ? path : resolve(this.root, relativePath(path));
    if (!inside(this.root, absolute)) throw new Error('Local path escapes the workspace.');
    const part = relative(this.root, absolute);
    let current = this.root;
    for (const name of part.split('/').filter(Boolean)) {
      current = join(current, name);
      if ((await lstat(current)).isSymbolicLink())
        throw new Error('Local symlinks are not uploaded.');
    }
    if (!inside(this.root, await realpath(absolute)))
      throw new Error('Local path escapes the workspace.');
    return absolute;
  }
  private baselineKey(server: DeploymentServer, root: string, target: string) {
    return digest(JSON.stringify(server)) + ':' + root + ':' + target;
  }
  private async plan(
    server: DeploymentServer,
    params: Params,
    automatic = false,
  ): Promise<DeploymentPlan> {
    if (this.saving) throw new Error('Deployment settings are being saved. Try again.');
    const revision = this.settings.revision;
    const secret = this.credential(server, params);
    const requested = params.paths;
    if (
      !Array.isArray(requested) ||
      !requested.length ||
      requested.length > 100 ||
      requested.some((path) => typeof path !== 'string')
    )
      throw new Error('Choose 1 to 100 local files or folders.');
    const expected = new Map<string, string>();
    if (automatic)
      for (const item of params.saved as DeploymentSavedFile[]) expected.set(item.path, item.hash);
    return this.withRemote(server, params, async (remote) => {
      const plan: DeploymentPlan = {
        id: randomUUID(),
        serverId: server.id,
        serverName: server.name,
        root: remote.root,
        revision,
        files: [],
        excluded: 0,
        createdAt: Date.now(),
      };
      const visited = new Set<string>();
      const targets = new Set<string>();
      let walked = 0,
        total = 0;
      const walk = async (input: string, depth = 0): Promise<void> => {
        if (depth > 64 || ++walked > 20000)
          throw new Error('Selection is too large or deeply nested. Choose a smaller folder.');
        const path = await this.local(input);
        if (visited.has(path)) return;
        visited.add(path);
        const local = relative(this.root, path);
        const target = destination(server, local);
        if (excluded(server, local, target ?? '')) {
          plan.excluded++;
          return;
        }
        if (
          server.keyPath &&
          path ===
            (await realpath(privateKeyPath(server.keyPath)).catch(() =>
              privateKeyPath(server.keyPath),
            ))
        ) {
          plan.excluded++;
          return;
        }
        const info = await lstat(path);
        if (info.isDirectory()) {
          if (
            target === null &&
            local &&
            !server.mappings.some((mapping) => mapping.local.startsWith(local + '/'))
          ) {
            plan.excluded++;
            return;
          }
          for await (const child of await opendir(path)) {
            const childPath = join(path, child.name);
            if ((await lstat(childPath)).isSymbolicLink()) {
              plan.excluded++;
              continue;
            }
            await walk(childPath, depth + 1);
          }
          return;
        }
        if (target === null || !info.isFile()) {
          plan.excluded++;
          return;
        }
        if (plan.files.length >= limits.files || (total += info.size) > limits.bytes)
          throw new Error(
            'A preview supports up to 5000 files and 1 GiB. Choose a smaller selection.',
          );
        if (targets.has(target))
          throw new Error(
            'Two local files map to the same remote destination. Fix the mappings first.',
          );
        targets.add(target);
        const file: DeploymentFile = {
          key: randomUUID(),
          local,
          remote: target,
          bytes: info.size,
          hash: '',
          remoteHash: null,
          mtime: info.mtimeMs,
          action: 'blocked',
        };
        plan.files.push(file);
        try {
          const content = await localContent(path);
          Object.assign(file, content);
          if (automatic && expected.get(path) !== content.hash)
            throw new Error(
              'Disk content differs from the acknowledged IDE save; external changes were not uploaded.',
            );
          const before = await remote.read(target);
          file.remoteHash = before?.hash ?? null;
          file.remoteMode = before?.mode;
          file.action = !before
            ? 'create'
            : before.hash === file.hash && params.force !== true
              ? 'unchanged'
              : 'replace';
          if (
            before &&
            before.hash !== file.hash &&
            this.baseline[this.baselineKey(server, remote.root, target)] !== before.hash
          ) {
            file.action = 'conflict';
            file.reason =
              'Remote content has no matching deployment baseline. Review before replacing it.';
          }
        } catch (error) {
          file.action = 'blocked';
          file.reason = redacted(error, secret);
        }
      };
      for (const path of requested as string[]) await walk(path);
      if (this.settings.revision !== revision)
        throw new Error('Deployment settings changed during preview. Try again.');
      while (this.plans.size >= 4) this.plans.delete(this.plans.keys().next().value!);
      this.plans.set(plan.id, plan);
      return plan;
    });
  }
  private ticket(params: Params) {
    const plan = this.plans.get(string(params, 'planId'));
    if (
      !plan ||
      plan.revision !== this.settings.revision ||
      Date.now() - plan.createdAt > 15 * 60_000
    )
      throw new Error('Upload preview expired or settings changed. Preview again.');
    return plan;
  }
  private async start(params: Params): Promise<DeploymentJob> {
    if (this.job?.status === 'running' || this.saving)
      throw new Error('A deployment operation is already running.');
    const plan = this.ticket(params);
    if (
      !Array.isArray(params.keys) ||
      !params.keys.length ||
      new Set(params.keys).size !== params.keys.length
    )
      throw new Error('Select at least one file.');
    const files = params.keys.map((key) => {
      const file = plan.files.find((file) => file.key === key);
      if (!file || file.action === 'blocked')
        throw new Error('Selection contains a blocked or unknown file.');
      return file;
    });
    const server = this.settings.servers.find((server) => server.id === plan.serverId)!;
    const secret = this.credential(server, params);
    const previous = this.job;
    this.job = {
      id: randomUUID(),
      serverId: server.id,
      serverName: server.name,
      status: 'running',
      startedAt: Date.now(),
      files: files.map((file) => ({
        key: file.key,
        local: file.local,
        remote: file.remote,
        bytes: file.bytes,
        sent: 0,
        status: 'queued',
      })),
    };
    this.controller = new AbortController();
    try {
      await this.journal();
    } catch (error) {
      this.job = previous;
      this.controller = undefined;
      throw error;
    }
    this.plans.delete(plan.id);
    this.running = this.run(server, plan, files, secret, this.controller.signal);
    void this.running.catch(() => {});
    return structuredClone(this.job);
  }
  private async run(
    server: DeploymentServer,
    plan: DeploymentPlan,
    files: DeploymentFile[],
    secret: string | undefined,
    signal: AbortSignal,
  ) {
    const job = this.job!;
    let snapshots = '';
    try {
      snapshots = await mkdtemp(join(this.directory, 'snapshot-'));
      await this.withRemote(
        server,
        secret === undefined ? {} : { credential: secret },
        async (remote) => {
          if (remote.root !== plan.root)
            throw new Error('Remote root changed since preview. Preview again.');
          for (let i = 0; i < files.length; i++) {
            const file = files[i],
              transfer = job.files[i];
            let temporary = '';
            try {
              cancelled(signal);
              const snapshot = join(snapshots, file.key);
              const content = await localContent(await this.local(file.local), snapshot, signal);
              if (content.hash !== file.hash)
                throw new Error('Local file changed since preview. Preview again.');
              if (file.action === 'unchanged') {
                const current = await remote.read(file.remote, signal);
                if (current?.hash !== file.hash)
                  throw new Error('Remote file changed since preview. Preview again.');
                transfer.status = 'unchanged';
                this.baseline[this.baselineKey(server, remote.root, file.remote)] = file.hash;
                continue;
              }
              transfer.status = 'uploading';
              temporary = await remote.stage(snapshot, file.remote, server, signal, (sent) => {
                transfer.sent = sent;
              });
              const current = await remote.read(file.remote, signal);
              if ((current?.hash ?? null) !== file.remoteHash)
                throw new Error('Remote file changed since preview. Preview again.');
              cancelled(signal);
              transfer.status = 'publishing';
              transfer.intendedHash = file.hash;
              transfer.message = 'Publishing file.';
              await this.journal();
              try {
                await remote.publish(temporary, file.remote, file.remoteHash !== null, signal);
              } catch (error) {
                if (
                  (error as { publicationStarted?: boolean }).publicationStarted &&
                  typeof (error as { code?: unknown }).code !== 'number' &&
                  !message(error).includes('does not support')
                ) {
                  transfer.status = 'unknown';
                  throw new Error(
                    'Publication outcome is unknown. Compare the remote file before retrying.',
                    { cause: error },
                  );
                }
                if (signal.aborted) throw error;
                throw new Error(
                  'Server refused atomic publication. The upload was not confirmed.',
                  { cause: error },
                );
              }
              const published = temporary;
              temporary = '';
              transfer.status = 'uploaded';
              transfer.sent = file.bytes;
              transfer.message = undefined;
              this.baseline[this.baselineKey(server, remote.root, file.remote)] = file.hash;
              await remote
                .metadata(published, server, file.remoteMode, content.mtime)
                .catch(() => {
                  transfer.message =
                    'Content uploaded; final permissions or timestamps could not be confirmed. The file may still have private 600 permissions.';
                })
                .finally(() => remote.closeStaged(published).catch(() => {}));
            } catch (error) {
              if (transfer.status !== 'unknown')
                transfer.status = signal.aborted ? 'cancelled' : 'failed';
              transfer.message = redacted(error, secret);
            } finally {
              if (temporary)
                await remote.removeTemporary(temporary).catch(() => {
                  transfer.message =
                    (transfer.message ?? '') + ' Temporary upload cleanup could not be confirmed.';
                });
              await this.journal();
            }
            if (signal.aborted) break;
          }
        },
        signal,
      );
    } catch (error) {
      for (const file of job.files)
        if (file.status === 'queued' || file.status === 'uploading') {
          file.status = signal.aborted ? 'cancelled' : 'failed';
          file.message = redacted(error, secret);
        }
    } finally {
      for (const file of job.files) {
        if (file.status === 'queued') file.status = 'cancelled';
        if (secret && file.message) file.message = file.message.split(secret).join('[credential]');
      }
      job.status = signal.aborted
        ? 'cancelled'
        : job.files.some(
              (file) =>
                file.status === 'failed' ||
                file.status === 'unknown' ||
                file.status === 'cancelled' ||
                !!file.message,
            )
          ? 'partial'
          : 'completed';
      job.finishedAt = Date.now();
      try {
        await writeJson(
          this.directory,
          'baseline.json',
          Object.fromEntries(Object.entries(this.baseline).slice(-20000)),
        );
        await this.journal();
      } catch {
        job.status = 'partial';
        for (const file of job.files)
          if (file.status === 'uploaded' && !file.message)
            file.message =
              'Content uploaded, but deployment history could not be saved. Compare before the next upload.';
      } finally {
        if (snapshots) await rm(snapshots, { recursive: true, force: true });
      }
    }
  }
  private async automatic(params: Params) {
    if (this.settings.autoUpload !== 'onSave' || params.serverId !== this.settings.defaultId)
      return { skipped: 'Automatic upload is off or the default server changed.' };
    if (this.job?.status === 'running') return { busy: true };
    if (!Array.isArray(params.saved) || params.saved.length > 100)
      throw new Error('Invalid saved-file batch.');
    for (const saved of params.saved) {
      const item = object(saved);
      if (
        typeof item.path !== 'string' ||
        typeof item.hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(item.hash) ||
        !Number.isInteger(item.revision) ||
        !Number.isInteger(item.workspaceGeneration)
      )
        throw new Error('Automatic uploads need acknowledged saved-file identities.');
    }
    const plan = await this.plan(
      this.server(params),
      { ...params, paths: params.saved.map((file) => object(file).path) },
      true,
    );
    const conflicts = plan.files.filter(
      (file) => file.action === 'conflict' || file.action === 'blocked',
    );
    if (conflicts.length) return { conflicts: conflicts.length, message: conflicts[0].reason };
    if (!plan.files.length) return { skipped: 'Saved files are excluded or outside mappings.' };
    return {
      job: await this.start({
        ...params,
        planId: plan.id,
        keys: plan.files.map((file) => file.key),
      }),
    };
  }
  private async compare(params: Params) {
    const plan = this.ticket(params);
    const file = plan.files.find((file) => file.key === params.key);
    if (!file || file.action === 'blocked' || file.bytes > limits.text)
      throw new Error('Choose an available text file up to 1 MiB.');
    const path = await this.local(file.local);
    const local = await localText(path, file.hash);
    return this.withRemote(this.server({ serverId: plan.serverId }), params, async (remote) => {
      const current = await remote.read(file.remote, undefined, true);
      if (current?.text?.includes('\0'))
        throw new Error('Binary files cannot be compared as text.');
      return {
        local,
        remote: current?.text ?? '',
        changed: (current?.hash ?? null) !== file.remoteHash,
      };
    });
  }
  private journal() {
    return writeJson(this.directory, 'transfer.json', this.job);
  }
  async dispose() {
    this.disposed = true;
    this.controller?.abort();
    for (const session of this.sessions) session.close();
    await this.running?.catch(() => {});
    this.secrets.clear();
    this.plans.clear();
  }
}
