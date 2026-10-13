import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    workspace: { type: 'string' },
    out: { type: 'string', default: 'packages/go/qualification/goserving-result.json' },
    offline: { type: 'boolean', default: false },
    package: { type: 'string', default: 'dist/packages/go' },
  },
});
if (!values.workspace)
  throw new Error(
    'Usage: node packages/go/qualification/qualify.mjs --workspace PATH [--out REPORT]',
  );
const root = resolve(values.workspace);
const files = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const configs = files.filter(
  (name) => /(^|\/)go\.mod$/.test(name) && !name.split('/').includes('.claude'),
);
const contexts = configs.map((config) => ({
  id: config,
  root: dirname(join(root, config)),
  language: 'go',
  configPath: join(root, config),
  state: 'loading',
}));
const oracle = JSON.parse(
  await readFile(new URL('./goserving-oracle.json', import.meta.url), 'utf8'),
);
const checkedPaths = new Set(
  files.filter((name) => /\.go$|(^|\/)go\.(?:mod|sum|work|work\.sum)$/.test(name)),
);
for (const config of configs)
  for (const file of ['go.mod', 'go.sum', 'go.work', 'go.work.sum'])
    checkedPaths.add(join(dirname(config), file));
checkedPaths.add('go.work');
checkedPaths.add('go.work.sum');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const before = new Map();
for (const path of checkedPaths) {
  try {
    before.set(path, digest(await readFile(join(root, path))));
  } catch (error) {
    if (error.code === 'ENOENT') before.set(path, null);
    else throw error;
  }
}
const sources = new Map();
for (const item of oracle.cases)
  for (const anchor of [item.source, ...item.expected])
    if (!sources.has(anchor.path))
      sources.set(anchor.path, await readFile(join(root, anchor.path), 'utf8'));
function point(anchor) {
  let offset = -1;
  const content = sources.get(anchor.path);
  for (let n = 0; n <= (anchor.occurrence ?? 0); n++) {
    offset = content.indexOf(anchor.needle, offset + 1);
    if (offset < 0) throw new Error(`Oracle source changed: ${anchor.path} ${anchor.needle}`);
  }
  const lines = content.slice(0, offset).split('\n');
  return { line: lines.length - 1, character: lines.at(-1).length };
}
// Resolve the independent oracle in full before starting semantic analysis.
const cases = oracle.cases.map((item) => ({
  ...item,
  position: point(item.source),
  expected: item.expected.map((a) => ({ path: a.path, position: point(a) })),
}));
const cache = await mkdtemp(join(tmpdir(), 'zwip-go-qualification-'));
const go = '/Users/grejo.j/.gvm/gos/go1.25.5/bin/go';
const child = spawn(join(resolve(values.package), 'bin/zwip-go'), [], {
  cwd: root,
  env: {
    ...process.env,
    ZWIP_GO: go,
    GOROOT: dirname(dirname(go)),
    GOTOOLCHAIN: 'local',
    GOWORK: 'off',
    GOPLSCACHE: join(cache, 'analysis'),
    GOCACHE: join(cache, 'build'),
    ...(values.offline ? { GOPROXY: 'off' } : {}),
    PATH: `${dirname(go)}:${process.env.PATH ?? ''}`,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let sequence = 0;
const pending = new Map();
const progress = new Map();
let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr = (stderr + chunk).slice(-32768);
});
createInterface({ input: child.stdout }).on('line', (line) => {
  const reply = JSON.parse(line);
  if (reply.method === 'navigation.progress') {
    const batch = reply.params;
    const observation = progress.get(batch?.id);
    if (!observation) return;
    const elapsed = performance.now() - observation.started;
    observation.firstBatchMs ??= elapsed;
    if (batch.locations.length) observation.firstResultMs ??= elapsed;
    observation.batches++;
    observation.valid &&=
      batch.state === 'loading' &&
      batch.documentRevision === 0 &&
      batch.workspaceGeneration === 1 &&
      batch.searchedContexts >= observation.searchedContexts;
    observation.searchedContexts = batch.searchedContexts;
    return;
  }
  const entry = pending.get(reply.id);
  if (!entry) return;
  pending.delete(reply.id);
  clearTimeout(entry.timer);
  if (reply.error) entry.reject(new Error(JSON.stringify(reply.error)));
  else entry.resolve(reply.result);
});
child.on('exit', () => {
  for (const item of pending.values()) {
    clearTimeout(item.timer);
    item.reject(new Error('Worker exited'));
  }
  pending.clear();
});
function request(method, params) {
  if (method === 'navigation.query')
    progress.set(params.id, {
      started: performance.now(),
      firstBatchMs: null,
      firstResultMs: null,
      batches: 0,
      searchedContexts: 0,
      valid: true,
    });
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } }) + '\n',
      );
      reject(new Error(`${method} timed out`));
    }, 300000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const report = {
  at: new Date().toISOString(),
  workspace: root,
  workspaceHead: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim(),
  oracleMethod: oracle.method,
  contextCount: contexts.length,
  sourceManifestSha256: digest(JSON.stringify([...before])),
  sourcesSha256: Object.fromEntries([...sources].map(([path, content]) => [path, digest(content)])),
  environment: {
    go,
    dependencyDownloads: !values.offline,
    pkgConfigPath: process.env.PKG_CONFIG_PATH ?? '',
  },
  scope:
    'Packaged Go worker, all tracked Go modules, source-adjudicated targets; normal module cache, readonly source/module configuration. Native UI behavior is not qualified by this run.',
  cases: [],
};
const key = (item) => `${item.path}:${item.position.line}:${item.position.character}`;
try {
  let started = performance.now();
  report.initialization = await request('initialize', { root, contexts, generation: 1 });
  report.initializeMs = performance.now() - started;
  console.log(`Acknowledged ${contexts.length} contexts in ${Math.round(report.initializeMs)}ms`);
  const priority = cases[0];
  const early = await request('navigation.query', {
    id: 'loading-observation',
    operation: priority.operation,
    path: join(root, priority.source.path),
    position: priority.position,
    documentRevision: 0,
    workspaceGeneration: 1,
  });
  report.initialQuery = {
    state: early.state,
    searchedContexts: early.searchedContexts,
    totalContexts: early.totalContexts,
    reasons: early.reasons,
  };
  const readyDeadline = performance.now() + 300000;
  for (;;) {
    report.readyStatus = await request('workspace.status', {});
    if (report.readyStatus.contexts.every((c) => c.state !== 'loading')) break;
    if (performance.now() > readyDeadline) throw new Error('Workspace readiness timed out');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  report.allContextsReadyMs = performance.now() - started;
  console.log(
    `All ${contexts.length} context loads settled in ${Math.round(report.allContextsReadyMs)}ms`,
  );
  for (const item of cases) {
    started = performance.now();
    const result = await request('navigation.query', {
      id: item.id,
      operation: item.operation,
      path: join(root, item.source.path),
      position: item.position,
      documentRevision: 0,
      workspaceGeneration: 1,
    });
    const actual = result.locations.map((location) => ({
      path: relative(root, location.path),
      position: location.range.start,
      relationship: location.relationship,
      contextIds: location.contextIds,
    }));
    const actualKeys = [...new Set(actual.map(key))].sort(),
      expectedKeys = [...new Set(item.expected.map(key))].sort();
    const targetsMatch = JSON.stringify(actualKeys) === JSON.stringify(expectedKeys);
    const observation = progress.get(item.id);
    const { started: _started, ...progressTiming } = observation;
    progress.delete(item.id);
    report.cases.push({
      id: item.id,
      operation: item.operation,
      source: { path: item.source.path, position: item.position },
      expected: item.expected,
      actual,
      state: result.state,
      searchedContexts: result.searchedContexts,
      totalContexts: result.totalContexts,
      reasons: result.reasons,
      targetsMatch,
      complete: result.state === 'complete',
      durationMs: performance.now() - started,
      progress: progressTiming,
    });
    console.log(
      `${item.id}: ${result.state}, targets ${targetsMatch ? 'match' : 'differ'}, ${Math.round(performance.now() - started)}ms`,
    );
  }
} catch (error) {
  report.error = String(error);
} finally {
  if (!child.killed && child.exitCode === null)
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', method: 'shutdown' }) + '\n');
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    setTimeout(() => child.kill('SIGTERM'), 3000).unref();
  });
  report.changedPaths = [];
  for (const [path, hash] of before) {
    let current;
    try {
      current = digest(await readFile(join(root, path)));
    } catch (error) {
      if (error.code === 'ENOENT') current = null;
      else throw error;
    }
    if (current !== hash) report.changedPaths.push(path);
  }
  report.sourceUnchanged = report.changedPaths.length === 0;
  report.targetMatches = report.cases.filter((item) => item.targetsMatch).length;
  report.completeCases = report.cases.filter((item) => item.complete).length;
  report.validProgressCases = report.cases.filter(
    (item) =>
      item.progress.valid &&
      item.progress.batches > 0 &&
      item.progress.searchedContexts === item.searchedContexts,
  ).length;
  report.passed =
    !report.error &&
    report.targetMatches === cases.length &&
    report.completeCases === cases.length &&
    report.validProgressCases === cases.length &&
    report.sourceUnchanged;
  report.stderrTail = stderr;
  await mkdir(dirname(resolve(values.out)), { recursive: true });
  await writeFile(resolve(values.out), JSON.stringify(report, null, 2) + '\n');
  await rm(cache, { recursive: true, force: true });
  console.log(
    `Saved ${values.out}: ${report.targetMatches}/${cases.length} target matches, ${report.completeCases} complete, source unchanged=${report.sourceUnchanged}`,
  );
  if (!report.passed) process.exitCode = 1;
}
