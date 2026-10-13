import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
export async function buildReactNextPackage({
  outDir = resolve(directory, '../../dist/packages/react-next'),
} = {}) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const features = await readFile(join(directory, 'features.json'));
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  manifest.checksums = { 'features.json': createHash('sha256').update(features).digest('hex') };
  await writeFile(join(outDir, 'features.json'), features);
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return outDir;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildReactNextPackage();
