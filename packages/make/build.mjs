import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSyntax } from '../../scripts/build-syntax.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
/** A declarative feature package: a Makefile grammar and no process. */
export async function buildMakePackage({
  outDir = resolve(directory, '../../dist/packages/make'),
} = {}) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await buildSyntax(join(directory, 'syntax.ts'), outDir);
  const checksums = {};
  for (const name of (await readdir(outDir)).sort())
    checksums[name] = createHash('sha256')
      .update(await readFile(join(outDir, name)))
      .digest('hex');
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  manifest.checksums = checksums;
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return outDir;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildMakePackage();
