import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
const { packageNotices } = await import(
  new URL('../../scripts/package-notices.mjs', import.meta.url).href
);
it('attributes the actual package root when a compiled subdirectory repeats its manifest identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zwip-notices-'));
  try {
    const root = join(directory, 'node_modules', '@fixture', 'client');
    await mkdir(join(root, 'dist', 'commonjs'), { recursive: true });
    const identity = { name: '@fixture/client', version: '1.0.0' };
    await writeFile(join(root, 'package.json'), JSON.stringify({ ...identity, license: 'MIT' }));
    await writeFile(join(root, 'LICENSE'), 'Fixture license text');
    await writeFile(join(root, 'dist', 'commonjs', 'package.json'), JSON.stringify(identity));
    const output = join(directory, 'output');
    await mkdir(join(output, 'runtime'), { recursive: true });
    await packageNotices(output, [
      { inputs: { [join(root, 'dist', 'commonjs', 'index.js')]: {} } },
    ]);
    expect(await readFile(join(output, 'THIRD-PARTY-NOTICES.txt'), 'utf8')).toContain(
      'Fixture license text',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
