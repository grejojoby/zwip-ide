import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const noticeName = /^(licen[cs]e|copying|notice|copyright|unlicense|third[-_]?party.*notice)/i;
const fullLicenseName = /^(licen[cs]e|copying|unlicense)/i;

export function productionCargoGraph(metadata) {
  const root = metadata.packages.find((pkg) => pkg.name === 'zwip' && !pkg.source);
  if (!root || !metadata.resolve) throw new Error('Missing production application Cargo graph');
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  if (nodes.get(root.id)?.features.includes('e2e'))
    throw new Error('E2E Cargo features cannot be included in production notices');
  const roles = new Map();
  const queue = [[root.id, 'application']];
  while (queue.length) {
    const [id, role] = queue.pop();
    if (roles.get(id)?.has(role)) continue;
    if (!roles.has(id)) roles.set(id, new Set());
    roles.get(id).add(role);
    for (const dep of nodes.get(id)?.deps ?? []) {
      for (const kind of dep.dep_kinds) {
        if (kind.kind === 'dev') continue;
        queue.push([dep.pkg, role === 'build' || kind.kind === 'build' ? 'build' : 'application']);
      }
    }
  }
  return metadata.packages
    .filter((pkg) => pkg.source && roles.has(pkg.id))
    .map((pkg) => {
      if (/^tauri-plugin-wdio/.test(pkg.name))
        throw new Error('E2E automation entered the production Cargo graph');
      return { ...pkg, roles: [...roles.get(pkg.id)].sort() };
    });
}

async function npmPackages(modules, root) {
  const found = new Map();
  for (const module of modules) {
    if (isAbsolute(module) || module.split('/').includes('..'))
      throw new Error(`UI module escapes project: ${module}`);
    let directory = dirname(resolve(root, module));
    while (directory.includes(`${join('', 'node_modules')}`)) {
      try {
        const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
        if (manifest.name && manifest.version) {
          if (manifest.name.startsWith('@wdio/'))
            throw new Error('E2E automation entered the production UI bundle');
          found.set(directory, {
            ecosystem: 'npm',
            name: manifest.name,
            version: manifest.version,
            license: manifest.license ?? null,
            repository: manifest.repository ?? null,
            directory,
            roles: ['bundled-ui'],
            source: 'installed npm package',
            licenseFile: null,
          });
          break;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  if (!found.size) throw new Error('UI bundle metadata contains no resolved dependency packages');
  return [...found.values()];
}

async function collectOriginals(directory, explicit) {
  const files = [];
  async function walk(current) {
    for (const item of await readdir(current, { withFileTypes: true })) {
      // Published package symlinks are not license evidence outside its directory.
      if (item.isSymbolicLink()) continue;
      const path = join(current, item.name);
      if (item.isDirectory()) {
        if (!['node_modules', '.git', 'target'].includes(item.name)) await walk(path);
      } else if (
        item.isFile() &&
        (noticeName.test(item.name) || relative(directory, path) === explicit)
      ) {
        files.push({
          relative: relative(directory, path),
          bytes: await readFile(path),
          license: fullLicenseName.test(item.name) || relative(directory, path) === explicit,
        });
      }
    }
  }
  await walk(directory);
  return files.sort((a, b) => a.relative.localeCompare(b.relative));
}

async function rustStandardLibrary(toolchain) {
  const directory =
    toolchain?.directory ??
    join(
      execFileSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' }).trim(),
      'share/doc/rust',
    );
  const version =
    toolchain?.version ?? execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim();
  const copyright = await readFile(join(directory, 'COPYRIGHT-library.html'));
  const names = (await readdir(join(directory, 'licenses'), { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => `licenses/${entry.name}`)
    .sort();
  if (!names.includes('licenses/MIT.txt') || !names.includes('licenses/Apache-2.0.txt'))
    throw new Error('Rust standard library distribution is missing its MIT/Apache license terms');
  const originals = [{ relative: 'COPYRIGHT-library.html', bytes: copyright, license: false }];
  for (const name of names) {
    if (name.split('/').includes('..'))
      throw new Error('Rust standard library license path escapes its directory');
    originals.push({ relative: name, bytes: await readFile(join(directory, name)), license: true });
  }
  return {
    ecosystem: 'rust-stdlib',
    name: 'rust-standard-library',
    version,
    license: 'See installed toolchain copyright inventory',
    repository: 'https://github.com/rust-lang/rust',
    source:
      'Installed Rust toolchain COPYRIGHT-library.html and its original distributed license files',
    roles: ['native-runtime'],
    originals,
  };
}

export async function generateApplicationNotices({
  root = projectRoot,
  moduleFile = join(root, 'dist/ui/application-modules.json'),
  output = join(root, 'dist/application-notices'),
  cargoMetadata,
  rustToolchain,
  vendorFile = join(root, 'licenses/application/provenance.json'),
} = {}) {
  const ui = JSON.parse(await readFile(moduleFile, 'utf8'));
  if (ui.version !== 1 || !Array.isArray(ui.modules))
    throw new Error('Unsupported UI module metadata');
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  if (ui.build === 'e2e') {
    await writeFile(
      join(output, 'NOT-FOR-DISTRIBUTION.txt'),
      'E2E build: production application notices are generated only for a production UI bundle.\n',
    );
    return { state: 'skipped-e2e' };
  }
  if (ui.build !== 'production') throw new Error('Unknown UI build kind');
  const metadata =
    cargoMetadata ??
    JSON.parse(
      execFileSync(
        'cargo',
        [
          'metadata',
          '--locked',
          '--offline',
          '--format-version',
          '1',
          '--filter-platform',
          'aarch64-apple-darwin',
          '--manifest-path',
          join(root, 'src-tauri/Cargo.toml'),
          '--features',
          'custom-protocol',
        ],
        { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
      ),
    );
  const dependencies = [
    ...(await npmPackages(ui.modules, root)),
    ...productionCargoGraph(metadata).map((pkg) => ({
      ecosystem: 'cargo',
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      repository: pkg.repository,
      source: pkg.source,
      directory: dirname(pkg.manifest_path),
      roles: pkg.roles,
      licenseFile: pkg.license_file,
    })),
    await rustStandardLibrary(rustToolchain),
  ].sort((a, b) =>
    `${a.ecosystem}:${a.name}@${a.version}`.localeCompare(`${b.ecosystem}:${b.name}@${b.version}`),
  );
  const vendor = JSON.parse(
    await readFile(vendorFile, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '{"version":1,"packages":{}}';
      throw error;
    }),
  );
  const inventory = {
    version: 1,
    state: 'complete',
    target: 'aarch64-apple-darwin',
    cargoFeatures: ['custom-protocol'],
    uiModuleMetadataSha256: hash(await readFile(moduleFile)),
    scope:
      'Actual bundled UI modules, production Cargo normal/build dependency closure and installed Rust standard library attribution. Build-only crates and procedural macros are retained for attribution; this is not a list of every object linked into the executable. Downloadable package notices are separate.',
    missing: [],
    dependencies: [],
  };
  const sections = [];
  for (const pkg of dependencies) {
    const key = `${pkg.ecosystem}:${pkg.name}@${pkg.version}`;
    const files = pkg.originals ?? (await collectOriginals(pkg.directory, pkg.licenseFile));
    const supplement = vendor.packages[key];
    if (supplement) {
      const vcs = JSON.parse(await readFile(join(pkg.directory, '.cargo_vcs_info.json'), 'utf8'));
      if (supplement.repository !== pkg.repository || supplement.commit !== vcs.git.sha1)
        throw new Error(`Vendored license provenance mismatch: ${key}`);
      for (const source of supplement.files) {
        const file = resolve(dirname(vendorFile), source.path);
        if (!file.startsWith(`${resolve(dirname(vendorFile))}/`))
          throw new Error(`Vendored license escapes directory: ${key}`);
        const bytes = await readFile(file);
        if (hash(bytes) !== source.sha256)
          throw new Error(`Vendored license checksum mismatch: ${key}`);
        files.push({
          relative: `upstream/${source.path}`,
          bytes,
          license: source.fullLicense === true,
          url: source.url,
        });
      }
    }
    if (!files.some((file) => file.license && file.bytes.length)) inventory.missing.push(key);
    const entry = {
      ecosystem: pkg.ecosystem,
      name: pkg.name,
      version: pkg.version,
      declaredLicense: pkg.license,
      repository: pkg.repository,
      source: pkg.source,
      roles: pkg.roles,
      licenses: [],
    };
    for (const file of files) {
      const path = join(
        'licenses',
        pkg.ecosystem,
        `${pkg.name.replaceAll('/', '__')}@${pkg.version}`,
        file.relative,
      );
      await mkdir(dirname(join(output, path)), { recursive: true });
      await writeFile(join(output, path), file.bytes);
      entry.licenses.push({
        path: path.replaceAll('\\', '/'),
        sha256: hash(file.bytes),
        ...(file.url ? { upstream: file.url } : {}),
      });
      sections.push(
        `${key}\nDeclared license: ${typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license)}\nSource file: ${file.relative}${file.url ? `\nUpstream: ${file.url}` : ''}\n\n${new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)}`,
      );
    }
    inventory.dependencies.push(entry);
  }
  if (inventory.missing.length) inventory.state = 'missing-license-text';
  await writeFile(join(output, 'inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
  if (inventory.missing.length)
    throw new Error(
      `Missing original license text: ${inventory.missing.join(', ')}; see ${join(output, 'inventory.json')}`,
    );
  await writeFile(
    join(output, 'THIRD-PARTY-NOTICES.txt'),
    'Zwip — application third-party notices\n\n' +
      inventory.scope +
      '\n\n' +
      sections.join('\n\n' + '='.repeat(72) + '\n\n') +
      '\n',
  );
  return { state: 'complete', dependencies: dependencies.length, output };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateApplicationNotices()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
