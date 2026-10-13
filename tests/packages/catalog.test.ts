import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-expect-error The pre-typecheck build entry is JavaScript.
import { buildReactNextPackage } from '../../packages/react-next/build.mjs';
// @ts-expect-error The standalone release entry is JavaScript.
import { buildArchives, buildCatalog } from '../../scripts/package-catalog.mjs';

it('produces a declarative feature ZIP and catalog with a whole archive digest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zwip-catalog-'));
  try {
    const packagesDir = join(root, 'packages');
    const outDir = join(root, 'catalog');
    await buildReactNextPackage({ outDir: join(packagesDir, 'react-next') });
    const catalog = await buildCatalog({
      baseUrl: 'https://catalog.example.test/releases/',
      packagesDir,
      outDir,
    });
    expect(catalog.version).toBe(1);
    expect(catalog.packages).toHaveLength(1);
    const entry = catalog.packages[0];
    expect(entry.dependencies).toEqual({ web: '^0.1.0' });
    const archive = join(outDir, basename(new URL(entry.url).pathname));
    expect(entry.sha256).toBe(
      createHash('sha256')
        .update(await readFile(archive))
        .digest('hex'),
    );
    const extracted = spawnSync('/usr/bin/unzip', ['-p', archive, 'manifest.json'], {
      encoding: 'utf8',
    });
    expect(extracted.status).toBe(0);
    const manifest = JSON.parse(extracted.stdout);
    expect(manifest.kind).toBe('feature');
    expect(manifest.executable).toBeUndefined();
    expect(manifest.checksums['features.json']).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      buildCatalog({ baseUrl: 'http://catalog.example.test/', packagesDir, outDir }),
    ).rejects.toThrow('HTTPS');
    await writeFile(join(packagesDir, 'react-next', 'unchecked.js'), 'unexpected');
    await expect(
      buildCatalog({ baseUrl: 'https://catalog.example.test/', packagesDir, outDir }),
    ).rejects.toThrow('checksum');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('creates locally installable ZIPs with checksums and no invented catalog URL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zwip-archives-'));
  try {
    const packagesDir = join(root, 'packages');
    const outDir = join(root, 'archives');
    await buildReactNextPackage({ outDir: join(packagesDir, 'react-next') });
    const archiveIndex = await buildArchives({ packagesDir, outDir });
    expect(archiveIndex.packages).toHaveLength(1);
    const entry = archiveIndex.packages[0];
    expect(entry.url).toBeUndefined();
    expect(entry.file).toBe('react-next-0.1.0-any-any.zip');
    expect(entry.sha256).toBe(
      createHash('sha256')
        .update(await readFile(join(outDir, entry.file)))
        .digest('hex'),
    );
    expect(JSON.parse(await readFile(join(outDir, 'archives.json'), 'utf8'))).toEqual(archiveIndex);
    await expect(readFile(join(outDir, 'catalog.json'))).rejects.toThrow();
    const extracted = spawnSync(
      '/usr/bin/unzip',
      ['-p', join(outDir, entry.file), 'manifest.json'],
      { encoding: 'utf8' },
    );
    expect(extracted.status).toBe(0);
    expect(JSON.parse(extracted.stdout).id).toBe('react-next');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
