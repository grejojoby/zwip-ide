import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateApplicationNotices, productionCargoGraph } from './application-notices.mjs';

const graph = (directory = '/fixture') => ({
  packages: [
    { id: 'root', name: 'zwip', source: null },
    {
      id: 'runtime',
      name: 'runtime',
      version: '1.0.0',
      source: 'registry+fixture',
      manifest_path: join(directory, 'Cargo.toml'),
      license: 'MIT',
      license_file: null,
      repository: null,
    },
    { id: 'builder', name: 'builder', source: 'registry+fixture' },
    { id: 'test', name: 'tauri-plugin-wdio', source: 'registry+fixture' },
  ],
  resolve: {
    nodes: [
      {
        id: 'root',
        features: ['custom-protocol'],
        deps: [
          { pkg: 'runtime', dep_kinds: [{ kind: null }] },
          { pkg: 'builder', dep_kinds: [{ kind: 'build' }] },
          { pkg: 'test', dep_kinds: [{ kind: 'dev' }] },
        ],
      },
      { id: 'runtime', deps: [] },
      { id: 'builder', deps: [] },
      { id: 'test', deps: [] },
    ],
  },
});

test('production closure retains build dependencies but excludes dev/E2E features', () => {
  const metadata = graph();
  const result = productionCargoGraph(metadata);
  assert.deepEqual(
    result.map((pkg) => pkg.name),
    ['runtime', 'builder'],
  );
  assert.deepEqual(result.find((pkg) => pkg.name === 'builder').roles, ['build']);
  metadata.resolve.nodes[0].features.push('e2e');
  assert.throws(() => productionCargoGraph(metadata), /E2E Cargo features/);
});

async function fixture(t, license = true) {
  const root = await mkdtemp(join(tmpdir(), 'zwip-notice-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const npm = join(root, 'node_modules/example');
  const cargo = join(root, 'cargo-runtime');
  const rust = join(root, 'rust-toolchain');
  for (const path of [npm, cargo, join(rust, 'licenses')]) await mkdir(path, { recursive: true });
  await writeFile(
    join(npm, 'package.json'),
    JSON.stringify({ name: 'example', version: '1.0.0', license: 'MIT' }),
  );
  const original = Buffer.from(
    'Copyright (c) Fixture\r\nPermission notice remains byte-exact.\r\n',
  );
  if (license) await writeFile(join(npm, 'LICENSE'), original);
  await writeFile(join(cargo, 'LICENSE'), 'Cargo fixture license.\n');
  await writeFile(
    join(rust, 'COPYRIGHT-library.html'),
    '<p>Fixture standard library attribution</p>',
  );
  await writeFile(join(rust, 'licenses/MIT.txt'), 'Fixture MIT text');
  await writeFile(join(rust, 'licenses/Apache-2.0.txt'), 'Fixture Apache text');
  const moduleFile = join(root, 'modules.json');
  await writeFile(
    moduleFile,
    JSON.stringify({ version: 1, build: 'production', modules: ['node_modules/example/index.js'] }),
  );
  const metadata = graph(cargo);
  metadata.resolve.nodes[0].deps = metadata.resolve.nodes[0].deps.filter(
    (dep) => dep.pkg === 'runtime',
  );
  return {
    root,
    moduleFile,
    original,
    options: {
      root,
      moduleFile,
      cargoMetadata: metadata,
      rustToolchain: { directory: rust, version: 'rustc-fixture' },
    },
  };
}

test('generator preserves original license bytes and produces local inventory', async (t) => {
  const { root, original, options } = await fixture(t);
  const result = await generateApplicationNotices(options);
  assert.equal(result.state, 'complete');
  const output = join(root, 'dist/application-notices');
  assert.deepEqual(await readFile(join(output, 'licenses/npm/example@1.0.0/LICENSE')), original);
  const inventory = JSON.parse(await readFile(join(output, 'inventory.json'), 'utf8'));
  assert.equal(inventory.dependencies.length, 3);
  assert.equal(inventory.state, 'complete');
  assert.equal(JSON.stringify(inventory).includes(root), false);
});

test('missing license text fails generation with a machine-readable report', async (t) => {
  const { root, options } = await fixture(t, false);
  await assert.rejects(
    generateApplicationNotices(options),
    /Missing original license text: npm:example@1.0.0/,
  );
  const output = join(root, 'dist/application-notices');
  const inventory = JSON.parse(await readFile(join(output, 'inventory.json'), 'utf8'));
  assert.deepEqual(inventory.missing, ['npm:example@1.0.0']);
  await assert.rejects(readFile(join(output, 'THIRD-PARTY-NOTICES.txt')), { code: 'ENOENT' });
});

test('E2E inputs do not produce a production attribution inventory', async (t) => {
  const { root, moduleFile, options } = await fixture(t);
  await writeFile(
    moduleFile,
    JSON.stringify({
      version: 1,
      build: 'e2e',
      modules: ['node_modules/@wdio/tauri-plugin/index.js'],
    }),
  );
  assert.equal((await generateApplicationNotices(options)).state, 'skipped-e2e');
  await assert.rejects(readFile(join(root, 'dist/application-notices/inventory.json')), {
    code: 'ENOENT',
  });
});

test('vendored license bytes must match recorded provenance checksums', async (t) => {
  const { root, options } = await fixture(t);
  const directory = join(root, 'licenses/application');
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(root, 'cargo-runtime/.cargo_vcs_info.json'),
    JSON.stringify({ git: { sha1: 'fixture-commit' } }),
  );
  await writeFile(join(directory, 'LICENSE'), 'changed original');
  await writeFile(
    join(directory, 'provenance.json'),
    JSON.stringify({
      version: 1,
      packages: {
        'cargo:runtime@1.0.0': {
          repository: null,
          commit: 'fixture-commit',
          files: [
            {
              path: 'LICENSE',
              sha256: '0'.repeat(64),
              fullLicense: true,
              url: 'https://example.test/pinned/LICENSE',
            },
          ],
        },
      },
    }),
  );
  await assert.rejects(generateApplicationNotices(options), /Vendored license checksum mismatch/);
});
