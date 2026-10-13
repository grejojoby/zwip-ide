import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir, platform, arch, cpus, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { waitForReadiness } from './benchmark-readiness.mjs';
import { targetKeys } from './benchmark-targets.mjs';
const { values } = parseArgs({
  options: {
    workspace: { type: 'string' },
    queries: { type: 'string' },
    out: { type: 'string' },
    samples: { type: 'string', default: '10' },
    package: { type: 'string', multiple: true },
    'skip-build': { type: 'boolean', default: false },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.workspace) {
  console.log(
    'Usage: npm run bench:workspace -- --workspace PATH [--queries fixed-queries.json] [--samples 10] [--package react-next] [--skip-build] [--out report.json]\nMeasures the core + installed workers. Extra packages are installed after the query language packages. --skip-build uses the existing debug binary and records its SHA256. This service benchmark does not certify native UI responsiveness or comparative resource improvement.',
  );
  process.exit(values.help ? 0 : 1);
}
const root = resolve(values.workspace),
  samples = Number(values.samples);
if (!Number.isInteger(samples) || samples < 1 || samples > 100)
  throw new Error('samples must be 1–100');
if (!values['skip-build'])
  execFileSync('cargo', ['build', '-p', 'ide-core', '--bin', 'zwip-core'], { stdio: 'inherit' });
const executable = resolve('target/debug/zwip-core');
const binarySha256 = createHash('sha256')
  .update(await readFile(executable))
  .digest('hex');
const data = await mkdtemp(join(tmpdir(), 'zwip-benchmark-'));
const started = performance.now();
const child = spawn(executable, [], {
  env: { ...process.env, ZWIP_DATA: data },
  stdio: ['pipe', 'pipe', 'inherit'],
});
let sequence = 0;
const pending = new Map();
createInterface({ input: child.stdout }).on('line', (line) => {
  const reply = JSON.parse(line);
  const item = pending.get(reply.id);
  if (item) {
    clearTimeout(item.timer);
    pending.delete(reply.id);
    if (reply.error) item.reject(new Error(reply.error));
    else item.resolve(reply.result);
  }
});
child.on('exit', () => {
  for (const item of pending.values()) {
    clearTimeout(item.timer);
    item.reject(new Error('Core exited'));
  }
  pending.clear();
});
const request = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} exceeded benchmark timeout`));
    }, 240000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
const memory = [];
const cpuTotals = new Map();
let monitoring = true;
let monitorError;
function seconds(time) {
  const parts = time.split(':').map(Number);
  return parts.reduce((value, part) => value * 60 + part, 0);
}
async function monitor() {
  while (monitoring) {
    try {
      const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,time='], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .map(([pid, ppid, rss, time]) => ({
          pid: Number(pid),
          ppid: Number(ppid),
          rssKiB: Number(rss),
          cpuSeconds: seconds(time),
        }));
      const ids = new Set([child.pid]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of rows) {
          if (ids.has(row.ppid) && !ids.has(row.pid)) {
            ids.add(row.pid);
            changed = true;
          }
        }
      }
      const tree = rows.filter((row) => ids.has(row.pid));
      memory.push({
        elapsedMs: performance.now() - started,
        rssKiB: tree.reduce((n, row) => n + row.rssKiB, 0),
        processes: tree.length,
      });
      for (const row of tree)
        cpuTotals.set(row.pid, Math.max(cpuTotals.get(row.pid) ?? 0, row.cpuSeconds));
    } catch (error) {
      monitorError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
const monitoringTask = monitor();
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * p) - 1];
};
const output = resolve(values.out ?? `artifacts/benchmark-${Date.now()}.json`);
let activation;
try {
  const snapshot = await request('workspace.open', { root });
  const includedSourcePaths = new Set(snapshot.files.map((file) => resolve(file.path)));
  const startupMs = performance.now() - started;
  const sourceHashes = {};
  let goLines = 0,
    goFiles = 0;
  for (const file of snapshot.files) {
    if (
      /\.(go|[cm]?[jt]sx?|html|css)$|(?:^|\/)(?:go\.(?:mod|sum|work)|(?:ts|js)config[^/]*\.json|package(?:-lock)?\.json)$/.test(
        file.relativePath,
      )
    ) {
      const bytes = await readFile(file.path);
      sourceHashes[file.relativePath] = hash(bytes);
      if (file.path.endsWith('.go')) {
        goFiles++;
        goLines += bytes.toString('utf8').split('\n').length - 1;
      }
    }
  }
  const revision = (() => {
    try {
      const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
      const repositoryRoot = execFileSync(
        'git',
        ['-C', root, 'rev-parse', '--show-toplevel'],
        options,
      ).trim();
      // A disposable copy may live below this application's repository. Its
      // parent repository's HEAD is not the copied source revision.
      if (resolve(repositoryRoot) !== resolve(snapshot.root)) return null;
      return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], options).trim();
    } catch {
      return null;
    }
  })();
  const fixtureInput = values.queries
    ? JSON.parse(await readFile(resolve(values.queries), 'utf8'))
    : [];
  // Source-adjudicated oracles use stable source sentinels, resolved against the
  // exact benchmark copy before any provider executes.
  async function position(source) {
    const content = await readFile(resolve(root, source.path), 'utf8');
    let offset = -1;
    for (let index = 0; index <= (source.occurrence ?? 0); index++) {
      offset = content.indexOf(source.needle, offset + 1);
      if (offset < 0)
        throw new Error(`Missing oracle sentinel in ${source.path}: ${source.needle}`);
    }
    offset += source.offset ?? 0;
    const prefix = content.slice(0, offset);
    return {
      line: prefix.split('\n').length - 1,
      character: prefix.length - prefix.lastIndexOf('\n') - 1,
    };
  }
  const queries = Array.isArray(fixtureInput)
    ? fixtureInput
    : await Promise.all(
        fixtureInput.cases.map(async (fixture) => ({
          id: fixture.id,
          path: fixture.source.path,
          operation: fixture.operation,
          comparison: fixture.comparison ?? 'exact all target positions',
          position: await position(fixture.source),
          expected: await Promise.all(
            fixture.expected.map(async (target) => {
              const point = await position(target);
              return `${target.path}:${point.line}:${point.character}`;
            }),
          ),
        })),
      );
  const languages = [
    ...new Set(queries.map((query) => (query.path.endsWith('.go') ? 'go' : 'web'))),
  ];
  const installedPackages = [];
  for (const id of [...new Set([...languages, ...(values.package ?? [])])]) {
    if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`Invalid package ID: ${id}`);
    const directory = resolve('dist/packages', id);
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    await request('package.install', { path: directory });
    await request('package.enable', { id, enabled: true });
    installedPackages.push(manifest);
    console.log(`Installed and enabled package ${id}.`);
  }
  let indexing = null;
  if (languages.length) {
    const analysisStarted = performance.now();
    activation = await request('workspace.symbols', {
      id: 'benchmark-activate',
      query: '__zwip_benchmark_readiness__',
      workspaceGeneration: snapshot.generation,
    });
    const initializationAcknowledgedMs = performance.now() - analysisStarted;
    const expectedContexts = snapshot.contexts.filter((context) =>
      languages.includes(context.language),
    );
    console.log(
      `Provider activation: ${activation.state}; ${(activation.reasons ?? []).join('; ')}`,
    );
    const readiness = await waitForReadiness(
      request,
      expectedContexts,
      installedPackages.map((manifest) => manifest.id),
      {
        onProgress: ({ contexts, missingContextIds }) => {
          const counts = {};
          for (const context of contexts) counts[context.state] = (counts[context.state] ?? 0) + 1;
          console.log(
            `Readiness: ${JSON.stringify(counts)}; missing contexts: ${missingContextIds.length}`,
          );
        },
      },
    );
    indexing = {
      initializationAcknowledgedMs,
      settledMs: performance.now() - analysisStarted,
      complete: true,
      activation,
      contexts: readiness.contexts,
    };
  }
  const results = [];
  for (const fixture of queries) {
    const path = resolve(root, fixture.path);
    const doc = await request('document.open', { path });
    const latencies = [];
    const sampleStates = [];
    const firstBatches = [],
      firstNonempty = [];
    const expected = Array.isArray(fixture.expected) ? [...fixture.expected].sort() : null;
    const workspaceOnly =
      fixture.comparison === 'exact workspace-owned target positions, excluding dependency files';
    const targetsOf = (result) =>
      targetKeys(result.locations, root, workspaceOnly ? includedSourcePaths : undefined);
    let coldMs;
    let final;
    for (let iteration = 0; iteration <= samples; iteration++) {
      const start = performance.now();
      const queryId = `bench-${sequence}`;
      let done = false,
        firstBatchMs = null,
        firstNonemptyMs = null;
      const response = request('navigation.query', {
        query: {
          id: queryId,
          operation: fixture.operation,
          path,
          position: fixture.position,
          documentRevision: doc.revision,
          workspaceGeneration: snapshot.generation,
          contextIds: fixture.contextIds,
          sourceContextId: fixture.sourceContextId,
        },
      }).finally(() => {
        done = true;
      });
      let progressError = null;
      const progress = (async () => {
        while (!done) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (done) break;
          const batch = await request('navigation.progress', { id: queryId });
          if (!batch) continue;
          firstBatchMs ??= performance.now() - start;
          if (batch.locations.length) firstNonemptyMs ??= performance.now() - start;
        }
      })().catch((error) => {
        progressError = String(error);
      });
      final = await response;
      const elapsed = performance.now() - start;
      await progress;
      firstBatchMs ??= elapsed;
      if (final.locations.length) firstNonemptyMs ??= elapsed;
      sampleStates.push({
        iteration,
        state: final.state,
        searchedContexts: final.searchedContexts,
        totalContexts: final.totalContexts,
        exactMatch: expected ? JSON.stringify(targetsOf(final)) === JSON.stringify(expected) : null,
        firstBatchMs,
        firstNonemptyMs,
        progressError,
      });
      if (iteration === 0) coldMs = elapsed;
      else {
        latencies.push(elapsed);
        firstBatches.push(firstBatchMs);
        if (firstNonemptyMs !== null) firstNonempty.push(firstNonemptyMs);
      }
    }
    const targets = targetsOf(final);
    results.push({
      id: fixture.id,
      path: fixture.path,
      operation: fixture.operation,
      state: final.state,
      searchedContexts: final.searchedContexts,
      totalContexts: final.totalContexts,
      reasons: final.reasons,
      coldMs,
      warmP50Ms: percentile(latencies, 0.5),
      warmP95Ms: percentile(latencies, 0.95),
      warmP99Ms: percentile(latencies, 0.99),
      warmFirstBatchP95Ms: percentile(firstBatches, 0.95),
      warmFirstNonemptyP95Ms: percentile(firstNonempty, 0.95),
      firstBatches,
      firstNonempty,
      comparison: fixture.comparison ?? 'exact all target positions',
      everySampleExact: expected ? sampleStates.every((sample) => sample.exactMatch) : null,
      latencies,
      sampleStates,
      everySampleComplete: sampleStates.every((sample) => sample.state === 'complete'),
      targets,
      expected,
      exactMatch: expected ? JSON.stringify(targets) === JSON.stringify(expected) : null,
    });
    const completed = results.at(-1);
    console.log(
      `${fixture.id}: all ${sampleStates.length} samples exact=${completed.everySampleExact}, complete=${completed.everySampleComplete}`,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const altered = [];
  for (const [path, before] of Object.entries(sourceHashes)) {
    try {
      if (hash(await readFile(join(root, path))) !== before) altered.push(path);
    } catch {
      altered.push(path);
    }
  }
  const report = {
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    scope: 'core-service-and-owned-workers',
    serviceBuild: {
      mode: 'debug',
      executable,
      sha256: binarySha256,
      skippedBuild: values['skip-build'],
    },
    qualified: false,
    limitations: [
      'Debug service build; renderer and WebKit are not measured.',
      'No equivalent-workload comparison has been run.',
      'RSS sums shared pages and is not physical footprint.',
      'Query fixtures require independently adjudicated expected targets.',
      'Short-lived processes between 250ms samples may be missed.',
      'First-batch times are host observations polled every 50ms; polling adds service traffic.',
    ],
    machine: {
      platform: platform(),
      architecture: arch(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      physicalMemoryBytes: totalmem(),
    },
    workspace: {
      root,
      revision,
      sourceManifestSha256: hash(JSON.stringify(sourceHashes)),
      includedFiles: snapshot.files.length,
      goFiles,
      goLines,
      contexts: snapshot.contexts,
      excluded: snapshot.excluded,
      changedFiles: altered,
    },
    startupMs,
    installedPackages,
    indexing,
    results,
    resources: {
      peakRssKiB: Math.max(0, ...memory.map((item) => item.rssKiB)),
      settledRssKiB: memory.at(-1)?.rssKiB,
      totalObservedCpuSeconds: [...cpuTotals.values()].reduce((a, b) => a + b, 0),
      monitorError,
      samples: memory,
    },
  };
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(
    `Saved ${output}\nIncluded ${snapshot.files.length} files, ${goFiles} Go files, ${snapshot.contexts.length} contexts. ${results.length} query fixtures. Qualification remains incomplete.`,
  );
  if (altered.length)
    throw new Error(`Benchmark workspace changed: ${altered.length} files. Inspect the report.`);
} catch (error) {
  const diagnosticsPath = `${output}.failure.json`;
  await mkdir(resolve(diagnosticsPath, '..'), { recursive: true });
  await writeFile(
    diagnosticsPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        scope: 'core-service-and-owned-workers',
        qualified: false,
        workspace: root,
        serviceBuild: {
          mode: 'debug',
          executable,
          sha256: binarySha256,
          skippedBuild: values['skip-build'],
        },
        error: String(error),
        activation,
        diagnostics: error.diagnostics,
      },
      null,
      2,
    ) + '\n',
  );
  console.error(`Failure diagnostics saved to ${diagnosticsPath}`);
  throw error;
} finally {
  monitoring = false;
  child.stdin.end();
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    setTimeout(() => child.kill('SIGKILL'), 3000).unref();
  });
  await monitoringTask;
  await rm(data, { recursive: true, force: true });
}
