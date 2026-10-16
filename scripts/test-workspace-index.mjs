import { spawnSync } from 'node:child_process';
// Reuse the native acceptance fixture and its explicit data-directory setup.
await import('../wdio.conf.mjs');
for (const phase of ['cold', 'warm']) {
  const result = spawnSync(
    process.execPath,
    [
      'node_modules/@wdio/cli/bin/wdio.js',
      'run',
      'wdio.conf.mjs',
      '--spec',
      'tests/e2e/workspace-index.mjs',
    ],
    {
      env: { ...process.env, ZWIP_INDEX_PHASE: phase },
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
