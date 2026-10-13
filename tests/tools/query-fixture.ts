import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
export async function queryFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'zwip-sql-worker-test-'));
  const path = join(directory, 'sql-query.cjs');
  try {
    await build({
      entryPoints: [resolve('packages/tools/src/sql-query.ts')],
      outfile: path,
      platform: 'node',
      format: 'cjs',
      bundle: true,
      target: 'node24',
      external: ['pg-native'],
    });
    return { path, dispose: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
