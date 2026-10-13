import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectProcesses, summarizeSamples } from './bench-native.mjs';

const processRow = (pid, ppid, responsiblePid, overrides = {}) => ({
  pid,
  ppid,
  responsiblePid,
  startTime: '100.000000',
  executable: `/bin/process-${pid}`,
  measurementError: 0,
  rssBytes: 100,
  physicalFootprintBytes: 80,
  cpuUserNs: '0',
  cpuSystemNs: '0',
  ...overrides,
});
const helper = (pid, owner) =>
  processRow(pid, 1, owner, {
    executable:
      '/System/Library/Frameworks/WebKit.framework/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent',
  });
test('includes owned launchd WebKit and language workers, separates task trees, excludes other apps', () => {
  const selected = selectProcesses(
    {
      processes: [
        processRow(10, 1, 10),
        helper(11, 10),
        processRow(12, 10, 10),
        processRow(13, 12, 10),
        processRow(14, 10, 10, { executable: '/packages/go/zwip-go' }),
        helper(15, 20),
        processRow(20, 1, 20),
      ],
    },
    {
      pid: 10,
      rootIdentity: '10:100.000000',
      taskIdentities: ['12:100.000000'],
      workerPrefixes: ['/packages'],
    },
  );
  assert.deepEqual(
    selected.processes.map((p) => [p.pid, p.group, p.role]).sort((a, b) => a[0] - b[0]),
    [
      [10, 'ide', 'application'],
      [11, 'ide', 'webkit-helper'],
      [12, 'task', 'task-root'],
      [13, 'task', 'task-descendant'],
      [14, 'ide', 'language-worker'],
    ],
  );
  assert.equal(selected.ambiguousWebKit.length, 0);
});
test('does not adopt unrelated WebKit sharing a launcher and exposes unavailable attribution', () => {
  const selected = selectProcesses(
    { processes: [processRow(10, 99, 99), helper(11, 99), helper(12, -1)] },
    { pid: 10 },
  );
  assert.deepEqual(
    selected.processes.map((p) => p.pid),
    [10],
  );
  assert.deepEqual(
    selected.ambiguousWebKit.map((p) => p.pid),
    [11, 12],
  );
});
test('pins roots and explicit helpers to process identities and retains reparented descendants', () => {
  const remembered = new Map();
  const options = { pid: 10, rootIdentity: '10:100.000000', helperIdentities: ['15:100.000000'] };
  selectProcesses(
    { processes: [processRow(10, 1, 10), processRow(11, 10, -1), helper(15, -1)] },
    options,
    remembered,
  );
  const selected = selectProcesses(
    {
      processes: [
        processRow(10, 1, 10),
        processRow(11, 1, -1),
        helper(15, 10),
        processRow(16, 1, -1),
      ],
    },
    options,
    remembered,
  );
  assert.deepEqual(selected.processes.map((p) => p.pid).sort(), [10, 11, 15]);
  assert.equal(
    selectProcesses(
      { processes: [processRow(10, 1, 10, { startTime: '101.000000' })] },
      options,
      remembered,
    ).rootMissing,
    true,
  );
});
test('CPU uses interval deltas and counts new processes separately from existing lifetime CPU', () => {
  const sampled = (timestampMs, processes) => ({
    timestampMs,
    elapsedMs: timestampMs - 100000,
    processes,
    rootMissing: false,
    ambiguousWebKit: [],
  });
  const row = (pid, cpu, group = 'ide', startTime = '90.000000') => ({
    ...processRow(pid, 1, pid, { cpuUserNs: String(cpu * 1e9), startTime }),
    group,
  });
  const report = summarizeSamples([
    sampled(100000, [row(10, 20), row(12, 50, 'task')]),
    sampled(101000, [row(10, 20.5), row(12, 50.2, 'task'), row(13, 0.1, 'ide', '100.500000')]),
    sampled(102000, [row(10, 21), row(12, 50.4, 'task')]),
  ]);
  assert.equal(report.groups.ide.cpuSeconds, 1.1);
  assert.ok(Math.abs(report.groups.task.cpuSeconds - 0.4) < 1e-10);
  assert.ok(Math.abs(report.groups.ide.meanCpuPercentOneCore - 55) < 1e-10);
  assert.equal(report.groups.ide.physicalFootprintBytes.max, 160);
});
test('missing counters are incomplete, not zero memory', () => {
  const report = summarizeSamples([
    {
      timestampMs: 100000,
      processes: [{ ...processRow(10, 1, 10), group: 'ide', measurementError: 1 }],
      ambiguousWebKit: [],
    },
  ]);
  assert.equal(report.coverage.selectedCountersComplete, false);
  assert.equal(report.groups.ide.physicalFootprintBytes.p50, null);
});

test(
  'native Mach counter conversion matches the independent process CPU clock',
  { skip: process.platform !== 'darwin' },
  async () => {
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const temp = mkdtempSync(join(tmpdir(), 'zwip-native-counter-test-'));
    try {
      const executable = join(temp, 'probe');
      execFileSync('/usr/bin/xcrun', [
        'clang',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        fileURLToPath(new URL('./bench-native-probe.c', import.meta.url)),
        '-o',
        executable,
      ]);
      const result = JSON.parse(execFileSync(executable, ['--self-test'], { encoding: 'utf8' }));
      assert.ok(result.ratio > 0.95 && result.ratio < 1.05);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
);
