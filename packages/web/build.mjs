import { build } from 'esbuild';
import { buildSyntax } from '../../scripts/build-syntax.mjs';
import { packageNotices } from '../../scripts/package-notices.mjs';
import { createHash } from 'node:crypto';
import { chmod, copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
const require = createRequire(import.meta.url);

/** Packages for the build machine's OS/architecture; cross-compilation is not implied. */
export async function buildWebPackage({ outDir = resolve(root, 'dist/packages/web') } = {}) {
  const output = resolve(outDir);
  await rm(output, { recursive: true, force: true });
  await mkdir(join(output, 'runtime'), { recursive: true });
  const built = await build({
    metafile: true,
    entryPoints: [join(directory, 'src/worker.ts')],
    outfile: join(output, 'worker.mjs'),
    platform: 'node',
    format: 'esm',
    mainFields: ['module', 'main'],
    bundle: true,
    target: 'node22',
    sourcemap: false,
    banner: {
      js: "import { createRequire as __nodeCreateRequire } from 'node:module'; const require = __nodeCreateRequire(import.meta.url);",
    },
  });
  await copyFile(process.execPath, join(output, 'runtime/node'));
  await chmod(join(output, 'runtime/node'), 0o755);
  const sdkRoot = dirname(require.resolve('typescript-sdk/package.json'));
  await mkdir(join(output, 'fallback-sdk/typescript'), { recursive: true });
  await cp(join(sdkRoot, 'lib'), join(output, 'fallback-sdk/typescript/lib'), { recursive: true });
  for (const file of ['package.json', 'LICENSE.txt', 'ThirdPartyNoticeText.txt'])
    await copyFile(join(sdkRoot, file), join(output, 'fallback-sdk/typescript', file));
  const syntax = await buildSyntax(join(directory, 'syntax.ts'), output);
  const runtime = await packageNotices(output, [built.metafile, syntax]);
  const checksums = {};
  async function collect(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const absolute = join(path, entry.name);
      if (entry.isDirectory()) await collect(absolute);
      else
        checksums[relative(output, absolute).split('\\').join('/')] = createHash('sha256')
          .update(await readFile(absolute))
          .digest('hex');
    }
  }
  await collect(output);
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  Object.assign(manifest, {
    platform: process.platform,
    architecture: process.arch,
    runtime,
    checksums,
  });
  await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = await buildWebPackage();
  process.stderr.write(`Web package built at ${output}\n`);
}
