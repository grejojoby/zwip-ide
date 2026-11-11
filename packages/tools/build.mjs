import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageNotices } from '../../scripts/package-notices.mjs';
const directory = dirname(fileURLToPath(import.meta.url));
const names = {
  sql: 'SQL databases',
  redis: 'Redis',
  http: 'HTTP client',
  'live-server': 'Live Server',
  deployment: 'SFTP Deployment',
};
export async function buildToolsPackages({
  outDir = resolve(directory, '../../dist/packages'),
  ids = Object.keys(names),
} = {}) {
  for (const id of ids) {
    const name = names[id];
    if (!name) throw new Error(`Unknown tool package: ${id}`);
    const output = join(outDir, id);
    await rm(output, { recursive: true, force: true });
    await mkdir(join(output, 'runtime'), { recursive: true });
    const entries = [`${id}-worker`, ...(id === 'sql' ? ['sql-query'] : [])];
    const metafiles = [];
    for (const entry of entries)
      metafiles.push(
        (
          await build({
            entryPoints: [join(directory, 'src', entry + '.ts')],
            outfile: join(output, entry + '.cjs'),
            platform: 'node',
            format: 'cjs',
            bundle: true,
            metafile: true,
            target: 'node24',
            external: ['pg-native', 'cpu-features', './crypto/build/Release/sshcrypto.node'],
            logOverride: { 'empty-import-meta': 'silent' },
          })
        ).metafile,
      );
    await copyFile(process.execPath, join(output, 'runtime/node'));
    await chmod(join(output, 'runtime/node'), 0o755);
    const runtime = await packageNotices(output, metafiles);
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
    await writeFile(
      join(output, 'manifest.json'),
      JSON.stringify(
        {
          id,
          name,
          version: id === 'sql' ? '0.2.1' : '0.1.0',
          coreVersion: '^0.1.0',
          description:
            id === 'deployment'
              ? 'SFTP file uploads, path mappings, remote browsing and upload on save'
              : id === 'live-server'
                ? 'Local static web server with automatic browser reload on save'
                : name,
          platform: process.platform,
          architecture: process.arch,
          runtime,
          languages: [id],
          capabilities:
            id === 'deployment'
              ? ['sftp', 'deploymentMappings', 'uploadPreview', 'uploadOnSave']
              : id === 'live-server'
                ? ['staticServer', 'liveReload']
                : id === 'sql'
                  ? ['schema', 'query', 'pagedResults', 'rowEditing', 'storedProcedures']
                  : id === 'redis'
                    ? ['keys', 'inspect']
                    : ['requestFiles', 'environments', 'responses'],
          executable: 'runtime/node',
          args: [`${id}-worker.cjs`, ...(id === 'sql' ? ['sql-query.cjs'] : [])],
          checksums,
        },
        null,
        2,
      ) + '\n',
    );
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildToolsPackages();
