import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  readdirSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildSyntax } from '../../scripts/build-syntax.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const go = process.env.ZWIP_GO ?? '/Users/grejo.j/.gvm/gos/go1.25.5/bin/go';
if (!path.isAbsolute(go)) throw new Error('ZWIP_GO must be an absolute executable path');
const lock = JSON.parse(readFileSync(path.join(root, 'upstream.lock.json'), 'utf8'));
const upstream = path.join(root, 'upstream');
const source = path.join(upstream, 'gopls');
const delve = path.join(upstream, 'delve');
const env = {
  ...process.env,
  GOROOT: path.dirname(path.dirname(go)),
  GOTOOLCHAIN: 'local',
  GOWORK: 'off',
  GOMODCACHE: path.join(upstream, 'modcache'),
  GOCACHE: path.join(upstream, 'buildcache'),
  GOPLSCACHE: path.join(upstream, 'analysiscache'),
  PATH: `${path.dirname(go)}${path.delimiter}${process.env.PATH ?? ''}`,
};
function run(args, options = {}) {
  const result = spawnSync(go, args, { cwd: source, env, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}
function writable(dir) {
  chmodSync(dir, 0o755);
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, item.name);
    if (item.isDirectory()) writable(target);
    else chmodSync(target, 0o644);
  }
}
function prepareModule(spec, destination, patches = []) {
  const download = JSON.parse(
    run(['mod', 'download', '-json', `${spec.module}@${spec.version}`], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'inherit'],
      encoding: 'utf8',
    }),
  );
  if (download.Sum !== spec.sum || download.GoModSum !== spec.goModSum)
    throw new Error(`Pinned ${spec.module} checksum mismatch`);
  const stampPath = path.join(destination, '.zwip-upstream-lock');
  const stamp = JSON.stringify({ spec, patches });
  if (!existsSync(stampPath) || readFileSync(stampPath, 'utf8') !== stamp) {
    rmSync(destination, { recursive: true, force: true });
    cpSync(download.Dir, destination, { recursive: true });
    writable(destination);
    for (const patch of patches) {
      const filename = path.join(destination, patch.file);
      const content = readFileSync(filename, 'utf8');
      if (content.split(patch.find).length !== 2)
        throw new Error(`Expected one patch anchor in ${patch.file}`);
      writeFileSync(filename, content.replace(patch.find, patch.replace));
    }
    writeFileSync(stampPath, stamp);
  }
}
function prepare() {
  mkdirSync(upstream, { recursive: true });
  const patch = JSON.parse(
    readFileSync(path.join(root, 'patches/tools-imports-gowork-off.json'), 'utf8'),
  );
  prepareModule(lock.tools, path.join(upstream, 'tools'), [patch]);
  const indexPatch = JSON.parse(
    readFileSync(path.join(root, 'patches/gopls-workspace-index.json'), 'utf8'),
  );
  prepareModule(lock, source, [indexPatch]);
  run(['mod', 'edit', '-replace=golang.org/x/tools=../tools']);
  // Remove obsolete generated command files before copying the owned overlay.
  rmSync(path.join(source, 'cmd/zwip-go'), { recursive: true, force: true });
  cpSync(path.join(root, 'overlay'), source, { recursive: true });
}

function buildDelve(output) {
  prepareModule(lock.delve, delve);
  run(['build', '-mod=readonly', '-trimpath', '-o', output, './cmd/dlv'], { cwd: delve });
}

function dependencyNotices(output) {
  const modules = new Map();
  for (const [cwd, target, main] of [
    [source, './cmd/zwip-go', lock],
    [delve, './cmd/dlv', lock.delve],
  ]) {
    const listing = run(
      [
        'list',
        '-mod=readonly',
        '-deps',
        '-f',
        '{{with .Module}}{{.Path}}|{{.Version}}|{{.Dir}}{{end}}',
        target,
      ],
      { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' },
    );
    for (const line of listing.split('\n').filter(Boolean)) {
      const [name, version, directory] = line.split('|');
      modules.set(name, { name, version: version || main.version, directory });
    }
  }
  const records = [];
  const notices = [
    '# Bundled Go module notices\n\nGenerated from the actual dependency graphs of zwip-go and dlv. Go standard-library code is covered by LICENSE.\n',
  ];
  for (const module of [...modules.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const files = [];
    const collect = (directory, prefix = '') => {
      for (const item of readdirSync(directory, { withFileTypes: true })) {
        if (
          !prefix &&
          !/^(?:licen[sc]es?|copying|notices?|copyright|patents)(?:[._-].*)?$/i.test(item.name)
        )
          continue;
        const relative = path.join(prefix, item.name);
        if (item.isDirectory()) collect(path.join(directory, item.name), relative);
        else if (item.isFile()) files.push(relative);
      }
    };
    collect(module.directory);
    records.push({ module: module.name, version: module.version, noticeFiles: files });
    notices.push(`\n## ${module.name} ${module.version}\n`);
    if (!files.length)
      notices.push('\nNo root notice file was present in the pinned module archive.\n');
    for (const filename of files)
      notices.push(
        `\n### ${filename}\n\n${readFileSync(path.join(module.directory, filename), 'utf8')}\n`,
      );
  }
  writeFileSync(path.join(output, 'THIRD-PARTY-NOTICES.md'), notices.join(''));
  writeFileSync(path.join(output, 'dependencies.json'), JSON.stringify(records, null, 2) + '\n');
}

export async function buildGoPackage({
  outDir = path.resolve(root, '../../dist/packages/go'),
} = {}) {
  prepare();
  const output = path.resolve(outDir);
  rmSync(output, { recursive: true, force: true });
  mkdirSync(path.join(output, 'bin'), { recursive: true });
  run(['build', '-trimpath', '-o', path.join(output, 'bin/zwip-go'), './cmd/zwip-go']);
  buildDelve(path.join(output, 'bin/dlv'));
  cpSync(path.join(source, 'LICENSE'), path.join(output, 'LICENSE'));
  cpSync(path.join(root, 'upstream.lock.json'), path.join(output, 'upstream.lock.json'));
  cpSync(path.join(delve, 'LICENSE'), path.join(output, 'DELVE-LICENSE'));
  dependencyNotices(output);
  await buildSyntax(path.join(root, 'syntax.ts'), output);
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  manifest.platform = process.platform;
  manifest.architecture = process.arch;
  for (const relative of [
    'bin/zwip-go',
    'bin/dlv',
    'LICENSE',
    'DELVE-LICENSE',
    'upstream.lock.json',
    'THIRD-PARTY-NOTICES.md',
    'dependencies.json',
    'syntax.mjs',
    'SYNTAX-NOTICES.txt',
  ]) {
    manifest.checksums[relative] = createHash('sha256')
      .update(readFileSync(path.join(output, relative)))
      .digest('hex');
  }
  writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? 'build';
  if (mode === 'build') console.error(`Go package built at ${await buildGoPackage()}`);
  else {
    prepare();
    if (mode === 'test') run(['test', '-count=1', ...process.argv.slice(3), './cmd/zwip-go']);
    else if (mode === 'debug-test') {
      const binary = path.join(upstream, 'dlv');
      buildDelve(binary);
      run(['test', '-count=1', ...process.argv.slice(3), './cmd/zwip-go'], {
        env: { ...env, ZWIP_DLV: binary },
      });
    } else if (mode === 'prepare') console.log(source);
    else if (mode === 'deps') run(['mod', 'download']);
    else throw new Error(`Unknown mode: ${mode}`);
  }
}
