import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { mkdtemp, readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { arch, cpus, loadavg, platform, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const identity = (row) => `${row.pid}:${row.startTime}`;
const webkit = (row) =>
  /(?:^|\/)com\.apple\.WebKit\.(?:WebContent|GPU|Networking)$/.test(row.executable);
const seconds = (row) => Number(BigInt(row.cpuUserNs) + BigInt(row.cpuSystemNs)) / 1e9;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const percentile = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
};

/** Match one process identity, not every application sharing a terminal's responsibility. */
export function selectProcesses(snapshot, options, remembered = new Map()) {
  const byPid = new Map(snapshot.processes.map((row) => [row.pid, row]));
  const root = byPid.get(options.pid);
  const selected = new Map();
  const ambiguousWebKit = [];
  const missingExplicit = [];
  const add = (row, group, role, evidence) =>
    selected.set(row.pid, { ...row, group, role, evidence });
  if (!root || (options.rootIdentity && identity(root) !== options.rootIdentity)) {
    return { processes: [], rootMissing: true, ambiguousWebKit, missingExplicit };
  }
  add(root, 'ide', 'application', 'root PID and start time');
  for (const row of snapshot.processes) {
    const previous = remembered.get(identity(row));
    if (previous)
      add(
        row,
        previous.group,
        previous.role,
        'previously observed ownership; same process identity',
      );
  }
  for (const [group, role, entries] of [
    ['ide', 'language-worker', options.workerIdentities ?? []],
    ['ide', 'explicit-helper', options.helperIdentities ?? []],
    ['task', 'task-root', options.taskIdentities ?? []],
  ]) {
    for (const key of entries) {
      const row = snapshot.processes.find((candidate) => identity(candidate) === key);
      if (row) add(row, group, role, 'operator-supplied PID pinned to start time');
      else missingExplicit.push(key);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of snapshot.processes) {
      if (selected.has(row.pid)) continue;
      const parent = selected.get(row.ppid);
      const owner = selected.get(row.responsiblePid);
      if (!parent && !owner) continue;
      // Self-responsible applications do not attribute themselves through this branch.
      if (row.responsiblePid === row.pid && !parent) continue;
      const group = parent?.group ?? owner.group;
      const worker = (options.workerPrefixes ?? []).some(
        (prefix) => row.executable === prefix || row.executable.startsWith(prefix + sep),
      );
      add(
        row,
        group,
        webkit(row)
          ? 'webkit-helper'
          : worker
            ? 'language-worker'
            : group === 'task'
              ? 'task-descendant'
              : 'ide-descendant',
        parent ? `parent ${parent.pid}` : `responsible process ${owner.pid}`,
      );
      changed = true;
    }
  }
  for (const row of snapshot.processes) {
    if (!webkit(row) || selected.has(row.pid)) continue;
    if (
      row.responsiblePid <= 0 ||
      (root.responsiblePid !== root.pid && row.responsiblePid === root.responsiblePid)
    ) {
      ambiguousWebKit.push({
        pid: row.pid,
        startTime: row.startTime,
        executable: row.executable,
        responsiblePid: row.responsiblePid,
        reason:
          row.responsiblePid <= 0
            ? 'ownership API unavailable or failed'
            : 'shares an outer responsible process; app ownership is unproven',
      });
    }
  }
  for (const row of selected.values())
    remembered.set(identity(row), { group: row.group, role: row.role });
  return {
    processes: [...selected.values()],
    rootMissing: false,
    ambiguousWebKit,
    missingExplicit,
  };
}

/** CPU is the observed interval delta, never the sum of each process's lifetime CPU. */
export function summarizeSamples(samples) {
  const previous = new Map();
  const groups = { ide: { cpuSeconds: 0 }, task: { cpuSeconds: 0 } };
  const intervals = [];
  const started = samples[0]?.timestampMs ?? 0;
  const warnings = new Set();
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    const totals = {
      ide: { rssBytes: 0, physicalFootprintBytes: 0, cpuSeconds: 0, processes: 0, unmeasured: 0 },
      task: { rssBytes: 0, physicalFootprintBytes: 0, cpuSeconds: 0, processes: 0, unmeasured: 0 },
    };
    if (sample.rootMissing)
      warnings.add('Root exited or PID was reused; later samples are incomplete.');
    if (sample.enumerationTruncated) warnings.add('Process enumeration was truncated.');
    if (sample.ambiguousWebKit.length)
      warnings.add('Some WebKit helpers have unproven ownership and are excluded from totals.');
    if (sample.error) warnings.add('One or more native samples failed.');
    for (const row of sample.processes) {
      const group = totals[row.group];
      group.processes++;
      if (row.measurementError) {
        group.unmeasured++;
        warnings.add('Selected processes had unavailable native counters.');
        continue;
      }
      group.rssBytes += row.rssBytes;
      group.physicalFootprintBytes += row.physicalFootprintBytes;
      const key = identity(row),
        current = seconds(row),
        before = previous.get(key);
      let delta = 0;
      if (before !== undefined) {
        if (current >= before) delta = current - before;
        else warnings.add('A process CPU counter moved backwards.');
      } else if (index > 0 && Number(row.startTime) * 1000 >= started) {
        delta = current;
      }
      group.cpuSeconds += delta;
      previous.set(key, current);
    }
    const intervalMs =
      index > 0
        ? (sample.elapsedMs ?? sample.timestampMs) -
          (samples[index - 1].elapsedMs ?? samples[index - 1].timestampMs)
        : null;
    for (const name of ['ide', 'task']) {
      if (sample.error || sample.rootMissing || totals[name].unmeasured) {
        totals[name].rssBytes = null;
        totals[name].physicalFootprintBytes = null;
      }
      groups[name].cpuSeconds += totals[name].cpuSeconds;
      totals[name].cpuPercentOneCore =
        intervalMs > 0 ? (totals[name].cpuSeconds / (intervalMs / 1000)) * 100 : null;
    }
    intervals.push({ timestampMs: sample.timestampMs, intervalMs, ...totals });
  }
  const durationSeconds =
    samples.length > 1
      ? ((samples.at(-1).elapsedMs ?? samples.at(-1).timestampMs) -
          (samples[0].elapsedMs ?? started)) /
        1000
      : 0;
  for (const name of ['ide', 'task']) {
    Object.assign(groups[name], {
      meanCpuPercentOneCore:
        durationSeconds > 0 ? (groups[name].cpuSeconds / durationSeconds) * 100 : null,
      rssBytes: {
        p50: percentile(
          intervals.map((s) => s[name].rssBytes),
          0.5,
        ),
        p95: percentile(
          intervals.map((s) => s[name].rssBytes),
          0.95,
        ),
        max: percentile(
          intervals.map((s) => s[name].rssBytes),
          1,
        ),
      },
      physicalFootprintBytes: {
        p50: percentile(
          intervals.map((s) => s[name].physicalFootprintBytes),
          0.5,
        ),
        p95: percentile(
          intervals.map((s) => s[name].physicalFootprintBytes),
          0.95,
        ),
        max: percentile(
          intervals.map((s) => s[name].physicalFootprintBytes),
          1,
        ),
      },
    });
  }
  return {
    durationSeconds,
    groups,
    intervals,
    coverage: {
      selectedCountersComplete: !samples.some(
        (s) =>
          s.error ||
          s.rootMissing ||
          s.enumerationTruncated ||
          s.processes.some((p) => p.measurementError),
      ),
      webKitOwnershipComplete: !samples.some((s) => s.ambiguousWebKit.length),
      warnings: [...warnings],
    },
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      pid: { type: 'string' },
      label: { type: 'string' },
      phase: { type: 'string', default: 'unspecified' },
      duration: { type: 'string', default: '60' },
      'interval-ms': { type: 'string', default: '250' },
      repeat: { type: 'string', default: '3' },
      'gap-ms': { type: 'string', default: '5000' },
      'task-pid': { type: 'string', multiple: true },
      'worker-pid': { type: 'string', multiple: true },
      'helper-pid': { type: 'string', multiple: true },
      'worker-prefix': { type: 'string', multiple: true },
      'no-tasks': { type: 'boolean' },
      metadata: { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help || !values.pid || !values.label || !values.out) {
    console.log(
      'Usage: node scripts/bench-native.mjs --pid PID --label LABEL --phase ready-idle --no-tasks --duration 60 --repeat 3 --out artifacts/native.json\nOptional: --interval-ms 250 --gap-ms 5000 --task-pid PID --worker-pid PID --helper-pid PID --worker-prefix PATH --metadata workload.json\nAttaches read-only; never launches, stops, or alters the IDE. Task PIDs and explicit helpers are pinned to initial process start time.',
    );
    process.exitCode = values.help ? 0 : 1;
    return;
  }
  if (platform() !== 'darwin') throw new Error('This native sampler requires macOS.');
  const number = (key, min, max) => {
    const n = Number(values[key]);
    if (!Number.isFinite(n) || n < min || n > max)
      throw new Error(`${key} must be between ${min} and ${max}`);
    return n;
  };
  const pid = number('pid', 1, 2147483647),
    durationMs = number('duration', 1, 3600) * 1000;
  const intervalMs = number('interval-ms', 50, 10000),
    repeat = number('repeat', 1, 20),
    gapMs = number('gap-ms', 0, 60000);
  if (![pid, repeat, intervalMs, gapMs].every(Number.isInteger))
    throw new Error('PID, repeat, and millisecond options must be integers.');
  if (values['no-tasks'] && values['task-pid']?.length)
    throw new Error('Use either --no-tasks or --task-pid.');
  const metadata = values.metadata
    ? JSON.parse(await readFile(resolve(values.metadata), 'utf8'))
    : null;
  const temp = await mkdtemp(join(tmpdir(), 'zwip-native-sampler-'));
  try {
    const probe = join(temp, 'probe');
    await execute('/usr/bin/xcrun', [
      'clang',
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      join(dirname(script), 'bench-native-probe.c'),
      '-o',
      probe,
    ]);
    const snapshot = async () =>
      JSON.parse(
        (await execute(probe, [], { maxBuffer: 16 * 1024 * 1024, timeout: 10000 })).stdout,
      );
    const first = await snapshot();
    const root = first.processes.find((row) => row.pid === pid);
    if (!root)
      throw new Error(
        'Root process is absent or unreadable. Run from a terminal with process-inspection permission.',
      );
    const identities = (key) =>
      (values[key] ?? []).map((value) => {
        const n = Number(value),
          row = first.processes.find((item) => item.pid === n);
        if (!Number.isInteger(n) || !row)
          throw new Error(`${key}: process ${value} is absent or unreadable.`);
        return identity(row);
      });
    const options = {
      pid,
      rootIdentity: identity(root),
      taskIdentities: identities('task-pid'),
      helperIdentities: identities('helper-pid'),
      workerIdentities: identities('worker-pid'),
      workerPrefixes: (values['worker-prefix'] ?? []).map((value) => resolve(value)),
    };
    const allOverrides = [
      ...options.taskIdentities,
      ...options.helperIdentities,
      ...options.workerIdentities,
    ];
    if (
      new Set(allOverrides).size !== allOverrides.length ||
      allOverrides.includes(options.rootIdentity)
    )
      throw new Error(
        'Process role overrides must be unique and cannot include the application root.',
      );
    const inspect = async (command, args) => {
      try {
        return (await execute(command, args)).stdout.trim();
      } catch {
        return null;
      }
    };
    const report = {
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      label: values.label,
      phase: values.phase,
      scope: 'native-application-owned-processes',
      qualifiedComparison: false,
      host: {
        platform: platform(),
        architecture: arch(),
        os: await inspect('/usr/bin/sw_vers', []),
        hardwareModel: await inspect('/usr/sbin/sysctl', ['-n', 'hw.model']),
        cpuModel: cpus()[0]?.model,
        logicalCpus: cpus().length,
        memoryBytes: totalmem(),
        power: await inspect('/usr/bin/pmset', ['-g', 'batt']),
        thermal: await inspect('/usr/bin/pmset', ['-g', 'therm']),
        loadAverage: loadavg(),
      },
      root: {
        pid,
        startTime: root.startTime,
        executable: root.executable,
        responsiblePid: root.responsiblePid,
      },
      options: { ...options, durationMs, intervalMs, repeat, gapMs },
      metadata,
      taskSeparation: values['no-tasks']
        ? 'operator asserts no application tasks are running'
        : values['task-pid']?.length
          ? 'explicit task roots and their descendants'
          : 'unverified: unmarked tasks may be included in IDE totals',
      limitations: [
        'Repeated windows reuse the running app; they are not independent cold starts.',
        'CPU is observed process-counter deltas. Processes born and exited between samples, or CPU consumed after their final observation, are missed.',
        'Physical footprint is a sum of per-process kernel ledger charges; RSS can double-count shared pages. Neither is whole-system incremental RAM.',
        'Responsible-process attribution is an optional private macOS diagnostic API and may change. Ambiguous WebKit helpers are excluded and listed, never assigned by name or launch time.',
        'Explicit helper and task roles are operator assertions. Unmarked task processes remain in IDE totals.',
        'UI latency, semantic correctness and indexing readiness must be recorded independently; resource samples alone do not establish equivalence or responsiveness.',
      ],
      trials: [],
    };
    let interrupted = false;
    const interrupt = () => {
      interrupted = true;
    };
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    try {
      for (let trial = 0; trial < repeat && !interrupted; trial++) {
        const samples = [],
          remembered = new Map(),
          start = performance.now();
        let next = start;
        do {
          const sampleStart = performance.now(),
            timestampMs = Date.now();
          try {
            const raw = await snapshot();
            samples.push({
              timestampMs,
              elapsedMs: sampleStart - start,
              probeMs: performance.now() - sampleStart,
              responsibilityApi: raw.responsibilityApi,
              timebase: raw.timebase,
              enumerationTruncated: raw.enumerationTruncated,
              inaccessibleOrExitedProcesses: raw.inaccessibleOrExitedProcesses,
              ...selectProcesses(raw, options, remembered),
            });
          } catch (error) {
            samples.push({
              timestampMs,
              elapsedMs: sampleStart - start,
              probeMs: performance.now() - sampleStart,
              error: String(error),
              rootMissing: true,
              ambiguousWebKit: [],
              processes: [],
            });
          }
          next += intervalMs;
          const delay = next - performance.now();
          if (delay > 0) await sleep(delay);
        } while (performance.now() - start <= durationMs && !interrupted);
        report.trials.push({
          trial: trial + 1,
          samples,
          ...summarizeSamples(samples),
          samplerProbeMs: {
            p50: percentile(
              samples.map((s) => s.probeMs),
              0.5,
            ),
            p95: percentile(
              samples.map((s) => s.probeMs),
              0.95,
            ),
          },
        });
        await mkdir(dirname(resolve(values.out)), { recursive: true });
        await writeFile(resolve(values.out), JSON.stringify(report, null, 2) + '\n');
        console.log(
          JSON.stringify({
            trial: trial + 1,
            groups: report.trials.at(-1).groups,
            coverage: report.trials.at(-1).coverage,
          }),
        );
        if (trial + 1 < repeat && !interrupted) await sleep(gapMs);
      }
    } finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
    }
    console.log(
      `Saved ${resolve(values.out)}. This report is not an equivalent-workload comparison or UI qualification.`,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === script) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
