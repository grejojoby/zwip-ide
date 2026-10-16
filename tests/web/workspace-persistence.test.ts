import { afterEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  rmSync,
  readFileSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { WebSemanticService } from '../../packages/web/src/service';
import type { BuildContext, NavigationQuery, NavigationBatch } from '../../src/contracts';
const roots: string[] = [];
const services: WebSemanticService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zwip-semantic-index-')));
  roots.push(root);
  const cache = realpathSync(mkdtempSync(join(tmpdir(), 'zwip-semantic-cache-')));
  roots.push(cache);
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2022', module: 'commonjs' },
      include: ['*.ts'],
    }),
  );
  writeFileSync(
    join(root, 'model.ts'),
    'export function work() { return 1 }\nexport class Model { run() { return work() } }\n',
  );
  writeFileSync(
    join(root, 'use.ts'),
    'import {work} from "./model";\nexport const result = work();\n',
  );
  const contexts: BuildContext[] = [
    { id: 'web', language: 'web', root, configPath: join(root, 'tsconfig.json'), state: 'loading' },
  ];
  const params = { root, generation: 9, contexts, workspaceIndex: { epoch: 'test' } };
  const query: NavigationQuery = {
    id: 'q',
    operation: 'definition',
    path: join(root, 'use.ts'),
    position: { line: 1, character: 24 },
    documentRevision: 0,
    workspaceGeneration: 9,
  };
  const open = () => {
    const service = new WebSemanticService(cache);
    services.push(service);
    service.initialize(params);
    return service;
  };
  return { root, cache, params, query, open };
}
it('restores whole-program navigation before hydrating compiler objects, and keeps version/overlay checks', async () => {
  const { open, query, root } = fixture();
  const cold = open();
  const expected = await cold.query(query);
  expect(expected.state).toBe('complete');
  expect(expected.locations[0]?.path).toBe(join(root, 'model.ts'));
  const indexed = await cold.checkpointWorkspace();
  expect(indexed.contexts[0].indexState, indexed.contexts[0].indexReason).toBe('built');
  cold.dispose();
  const restored = open();
  expect(restored.workspaceStatus().contexts[0]).toMatchObject({
    indexState: 'restored',
    compilerHydrated: false,
  });
  expect(await restored.query(query)).toEqual(expected);
  expect(restored.workspaceStatus().contexts[0].compilerHydrated).toBe(false);
  const refs = { ...query, operation: 'references' as const };
  expect(await restored.query(refs)).toEqual(await coldQuery(refs));
  expect((await restored.query({ ...query, workspaceGeneration: 8 })).state).toBe('failed');
  expect((await restored.query({ ...query, documentRevision: 1 })).state).toBe('failed');
  restored.updateDocument({
    path: query.path,
    content: readFileSync(query.path, 'utf8').replace('work();', 'missing();'),
    revision: 1,
  });
  expect((await restored.query({ ...query, documentRevision: 1 })).locations).toEqual([]);
  expect((await restored.checkpointWorkspace()).contexts[0].indexState).toBe('invalidated');
  restored.dispose();
  expect(open().workspaceStatus().contexts[0].indexState).toBe('restored');
  async function coldQuery(q: NavigationQuery) {
    const live = new WebSemanticService();
    services.push(live);
    live.initialize({
      root,
      generation: 9,
      contexts: [
        {
          id: 'web',
          language: 'web',
          root,
          configPath: join(root, 'tsconfig.json'),
          state: 'loading',
        },
      ],
    });
    return live.query(q);
  }
});
it('invalidates timestamp-preserving offline edits, additions, configuration changes, and force rebuild', async () => {
  const { open, query, root, params, cache } = fixture();
  const service = open();
  await service.checkpointWorkspace();
  service.dispose();
  const file = join(root, 'model.ts');
  const info = statSync(file);
  writeFileSync(file, readFileSync(file, 'utf8').replace('work', 'task'));
  utimesSync(file, info.atime, info.mtime);
  const changed = open();
  expect(changed.workspaceStatus().contexts[0].indexState).not.toBe('restored');
  expect((await changed.query(query)).locations.map((item) => item.path)).toEqual([query.path]);
  await changed.checkpointWorkspace();
  changed.dispose();
  expect(open().workspaceStatus().contexts[0].indexState).toBe('restored');
  writeFileSync(join(root, 'extra.ts'), 'export const extra = 1;');
  expect(open().workspaceStatus().contexts[0].indexState).not.toBe('restored');
  const forced = new WebSemanticService(cache);
  services.push(forced);
  forced.initialize({ ...params, workspaceIndex: { epoch: 'test', rebuild: true } });
  expect(forced.workspaceStatus().contexts[0].indexState).not.toBe('restored');
});
it('loads semantic artifacts in a fresh worker process without compiler hydration', async () => {
  const { root, cache, params, query } = fixture();
  const worker = join(cache, 'worker.mjs');
  await build({
    entryPoints: ['packages/web/src/worker.ts'],
    outfile: worker,
    platform: 'node',
    format: 'esm',
    mainFields: ['module', 'main'],
    bundle: true,
    target: 'node22',
    banner: {
      js: "import {createRequire as __r} from 'node:module'; const require=__r(import.meta.url);",
    },
  });
  // The bundled fallback SDK is normally installed beside the worker by the package builder.
  const { mkdirSync, symlinkSync } = await import('node:fs');
  mkdirSync(join(cache, 'fallback-sdk/typescript/lib'), { recursive: true });
  symlinkSync(
    join(process.cwd(), 'node_modules/typescript-sdk/lib/typescript.js'),
    join(cache, 'fallback-sdk/typescript/lib/typescript.js'),
  );
  async function run(cold: boolean) {
    const child = spawn(process.execPath, [worker], {
      env: { ...process.env, ZWIP_PACKAGE_CACHE: join(cache, 'data') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let errors = '';
    child.stderr.on('data', (x) => (errors += x));
    let sequence = 0;
    type RpcResult = ReturnType<WebSemanticService['workspaceStatus']> & NavigationBatch;
    type Reply = { id: number; result: RpcResult; error?: { message: string } };
    const pending = new Map<number, (value: Reply) => void>();
    createInterface({ input: child.stdout }).on('line', (line) => {
      const response = JSON.parse(line);
      pending.get(response.id)?.(response);
    });
    const request = (method: string, p: unknown = {}) =>
      new Promise<RpcResult>((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, (value) => {
          pending.delete(id);
          if (value.error) reject(new Error(value.error.message));
          else resolve(value.result);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: p }) + '\n');
      });
    try {
      await request('initialize', params);
      if (cold) await request('workspace.checkpoint');
      const status = await request('workspace.status');
      const result = await request('navigation.query', query);
      const after = await request('workspace.status');
      await request('shutdown');
      expect(errors).toBe('');
      return { status, result, after };
    } finally {
      child.stdin.end();
      child.kill();
    }
  }
  const cold = await run(true);
  expect(cold.status.contexts[0].indexState).toBe('built');
  const warm = await run(false);
  expect(warm.status.contexts[0]).toMatchObject({
    indexState: 'restored',
    compilerHydrated: false,
  });
  expect(warm.result).toEqual(cold.result);
  expect(warm.after.contexts[0].compilerHydrated).toBe(false);
  expect(warm.result.locations[0]?.path).toBe(join(root, 'model.ts'));
}, 30000);
it('reports cache publication failures while keeping live semantic queries available', async () => {
  const { root, params, query, cache } = fixture();
  const blocked = join(cache, 'not-a-directory');
  writeFileSync(blocked, 'occupied');
  const service = new WebSemanticService(blocked);
  services.push(service);
  service.initialize(params);
  const expected = await service.query(query);
  expect(expected.locations[0]?.path).toBe(join(root, 'model.ts'));
  const status = await service.checkpointWorkspace();
  expect(status.contexts[0].indexState).toBe('failed');
  expect(await service.query(query)).toEqual(expected);
});
