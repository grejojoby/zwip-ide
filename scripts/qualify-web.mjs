import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
const { values } = parseArgs({
  options: {
    workspace: { type: 'string' },
    'source-workspace': { type: 'string' },
    out: { type: 'string', default: 'artifacts/web-goserving-qualification.json' },
    package: { type: 'string', default: 'dist/packages/web' },
  },
});
if (!values.workspace)
  throw new Error('Usage: node scripts/qualify-web.mjs --workspace PATH [--out REPORT]');
const root = resolve(values.workspace),
  output = resolve(values.out),
  packagePath = resolve(values.package),
  original = resolve(values['source-workspace'] ?? values.workspace);
const oracle = JSON.parse(
  await readFile(
    new URL('../tests/web/qualification/goserving-oracle.json', import.meta.url),
    'utf8',
  ),
);
const sources = new Map();
for (const item of oracle.cases)
  for (const anchor of [item.source, ...item.expected])
    if (!sources.has(anchor.path))
      sources.set(anchor.path, await readFile(join(root, anchor.path), 'utf8'));
for (const config of oracle.contexts)
  for (const path of [
    config,
    join(dirname(config), 'package.json'),
    join(dirname(config), 'package-lock.json'),
  ])
    sources.set(path, await readFile(join(root, path), 'utf8'));
for (const [path, content] of sources)
  if ((await readFile(join(original, path), 'utf8')) !== content)
    throw new Error(`Disposable copy does not match original source: ${path}`);
const hashes = () =>
  Object.fromEntries(
    [...sources].map(([path, content]) => [
      path,
      createHash('sha256').update(content).digest('hex'),
    ]),
  );
function point(anchor) {
  let offset = -1;
  const content = sources.get(anchor.path);
  for (let i = 0; i <= (anchor.occurrence ?? 0); i++) {
    offset = content.indexOf(anchor.needle, offset + 1);
    if (offset < 0) throw new Error(`Oracle source changed: ${anchor.path} ${anchor.needle}`);
  }
  const before = content.slice(0, offset).split('\n');
  return { line: before.length - 1, character: before.at(-1).length };
}
// Resolve the complete independent oracle before launching the provider.
const cases = oracle.cases.map((item) => ({
  ...item,
  position: point(item.source),
  expected: item.expected.map((anchor) => ({
    path: anchor.path,
    position: point(anchor),
    relationship: anchor.relationship,
  })),
}));
const child = spawn(join(packagePath, 'runtime/node'), [join(packagePath, 'worker.mjs')], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'inherit'],
});
let sequence = 0;
const pending = new Map();
createInterface({ input: child.stdout }).on('line', (line) => {
  const reply = JSON.parse(line),
    p = pending.get(reply.id);
  if (!p) return;
  pending.delete(reply.id);
  clearTimeout(p.timer);
  if (reply.error) p.reject(new Error(JSON.stringify(reply.error)));
  else p.resolve(reply.result);
});
child.on('exit', () => {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error('Worker exited'));
  }
  pending.clear();
});
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 120000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const contexts = oracle.contexts.map((configPath) => ({
  id: configPath.split('/')[1],
  language: 'web',
  configPath: join(root, configPath),
  root: dirname(join(root, configPath)),
  state: 'loading',
}));
const report = {
  at: new Date().toISOString(),
  workspace: root,
  sourceWorkspace: original,
  disposableCopy: root !== original,
  workspaceHead: execFileSync('git', ['-C', original, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim(),
  oracleMethod: oracle.method,
  sourceSha256: hashes(),
  cases: [],
  scope:
    'Packaged worker with both real configured apps; source-based targets only. Native UI behavior is not qualified by this run.',
};
function key(item, relationship) {
  return `${item.path}:${item.position.line}:${item.position.character}${relationship ? ':' + item.relationship : ''}`;
}
try {
  const started = performance.now();
  report.initialization = await request('initialize', {
    root,
    contexts,
    generation: 1,
    enabledPackages: ['web', 'react-next'],
  });
  report.initializeMs = performance.now() - started;
  for (const item of cases) {
    const started = performance.now();
    const result = await request('navigation.query', {
      id: item.id,
      operation: item.operation,
      path: join(root, item.source.path),
      position: item.position,
      documentRevision: 0,
      workspaceGeneration: 1,
    });
    const actual = result.locations
      .map((location) => ({
        path: relative(root, location.path),
        position: location.range.start,
        relationship: location.relationship,
      }))
      .filter(
        (location) => !location.path.startsWith('..') && !location.path.includes('/node_modules/'),
      );
    const useRelationship = item.expected.some((target) => target.relationship);
    const actualKeys = [...new Set(actual.map((target) => key(target, useRelationship)))].sort(),
      expectedKeys = [
        ...new Set(item.expected.map((target) => key(target, useRelationship))),
      ].sort();
    const targetsMatch = JSON.stringify(actualKeys) === JSON.stringify(expectedKeys);
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
    });
  }
  report.sourceUnchanged = true;
  for (const [path, content] of sources)
    if (
      (await readFile(join(root, path), 'utf8')) !== content ||
      (await readFile(join(original, path), 'utf8')) !== content
    )
      report.sourceUnchanged = false;
  report.targetMatches = report.cases.filter((item) => item.targetsMatch).length;
  report.completeCases = report.cases.filter((item) => item.complete).length;
  report.passed =
    report.targetMatches === cases.length &&
    report.completeCases === cases.length &&
    report.sourceUnchanged;
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({
      report: output,
      targetMatches: report.targetMatches,
      completeCases: report.completeCases,
      total: cases.length,
      sourceUnchanged: report.sourceUnchanged,
      passed: report.passed,
    }),
  );
  if (!report.passed) process.exitCode = 1;
} finally {
  try {
    await request('shutdown', {});
  } catch {}
  child.kill();
}
