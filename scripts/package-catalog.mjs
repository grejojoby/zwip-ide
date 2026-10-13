import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function https(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new Error('Catalog base URL must use HTTPS without credentials or fragments.');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}
const run = (cmd, args, cwd) =>
  new Promise((accept, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', (data) => {
      error += data.toString();
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? accept() : reject(new Error(`${cmd} failed (${code}): ${error}`)),
    );
  });
async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function validateAssets(source, manifest, directory = source, found = new Set()) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()))
      throw new Error('Package archives cannot contain symlinks or special files.');
    if (entry.isDirectory()) await validateAssets(source, manifest, path, found);
    else {
      const name = path.slice(source.length + 1).replaceAll('\\', '/');
      if (name === 'manifest.json') continue;
      if (manifest.checksums?.[name] !== (await digest(path)))
        throw new Error(`Missing or incorrect checksum for ${name}.`);
      found.add(name);
    }
  }
  if (
    directory === source &&
    Object.keys(manifest.checksums ?? {}).some((name) => !found.has(name))
  )
    throw new Error('Manifest names missing package assets.');
}

/** Local ZIPs and their digests need no network location or invented hosting URL. */
export async function buildArchives({
  packagesDir = join(root, 'dist/packages'),
  outDir = join(root, 'dist/catalog'),
} = {}) {
  await mkdir(outDir, { recursive: true });
  const entries = [];
  for (const directory of (await readdir(packagesDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const source = join(packagesDir, directory.name);
    const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
    const { id, name, version, platform, architecture, dependencies = {} } = manifest;
    if (
      !/^[a-z0-9-]+$/.test(id) ||
      !/^[0-9A-Za-z.+-]+$/.test(version) ||
      !/^[a-z0-9-]+$/.test(platform) ||
      !/^[a-z0-9_-]+$/.test(architecture)
    )
      throw new Error(`Invalid package metadata in ${directory.name}.`);
    await validateAssets(source, manifest);
    const archive = join(outDir, `${id}-${version}-${platform}-${architecture}.zip`);
    await rm(archive, { force: true });
    await run('/usr/bin/zip', ['-q', '-r', resolve(archive), '.'], source);
    entries.push({
      id,
      name,
      version,
      platform,
      architecture,
      dependencies,
      file: basename(archive),
      sha256: await digest(archive),
    });
  }
  const archives = { version: 1, packages: entries };
  await writeFile(join(outDir, 'archives.json'), `${JSON.stringify(archives, null, 2)}\n`);
  return archives;
}

/** Creates upload-ready ZIPs and catalog.json; it does not publish or invent a host. */
export async function buildCatalog({ baseUrl, ...options }) {
  const base = https(baseUrl);
  const archives = await buildArchives(options);
  const catalog = {
    version: 1,
    packages: archives.packages.map(({ file, ...entry }) => ({
      ...entry,
      url: new URL(file, base).href,
    })),
  };
  const outDir = options.outDir ?? join(root, 'dist/catalog');
  await writeFile(join(outDir, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  return catalog;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--archives-only')) {
    await buildArchives();
  } else {
    const index = process.argv.indexOf('--base-url');
    const baseUrl = index >= 0 ? process.argv[index + 1] : process.env.ZWIP_PACKAGE_BASE_URL;
    if (!baseUrl)
      throw new Error(
        'Supply --base-url or ZWIP_PACKAGE_BASE_URL for HTTPS hosting, or --archives-only for local ZIPs.',
      );
    await buildCatalog({ baseUrl });
  }
}
