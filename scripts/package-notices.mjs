import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Generate attribution from the dependency files actually included by esbuild. */
export async function packageNotices(output, metafiles) {
  if (process.version !== 'v24.16.0')
    throw new Error('Package builds require pinned Node v24.16.0.');
  const packages = new Map();
  for (const file of metafiles.flatMap((meta) => Object.keys(meta.inputs))) {
    if (!file.includes('node_modules/')) continue;
    // Compiled distributions can repeat the package identity in nested
    // package.json files. Attribution belongs to the node_modules package root.
    const marker = 'node_modules/';
    const boundary = file.lastIndexOf(marker) + marker.length;
    const parts = file.slice(boundary).split('/');
    const directory = resolve(
      file.slice(0, boundary),
      ...parts.slice(0, parts[0].startsWith('@') ? 2 : 1),
    );
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    if (manifest.name && manifest.version)
      packages.set(`${manifest.name}@${manifest.version}`, directory);
  }
  const sections = [];
  for (const [name, directory] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    const files = (await readdir(directory)).filter((name) =>
      /^(license|licence|copying|notice|thirdpartynotice)/i.test(name),
    );
    let notices = (
      await Promise.all(files.map((file) => readFile(join(directory, file), 'utf8')))
    ).join('\n\n');
    if (!notices) {
      const readme = await readFile(join(directory, 'README.md'), 'utf8').catch(() => '');
      notices = readme.match(/^#+\s+licen[sc]e\b[^\n]*\n[\s\S]*/im)?.[0] ?? '';
    }
    // These published workspace packages omit the monorepo license file.
    if (
      !notices &&
      (name.startsWith('@redis/') || name.startsWith('redis@')) &&
      manifest.version === '6.3.0'
    )
      notices = await readFile(join(root, 'packages/runtime/NODE-REDIS-LICENSE'), 'utf8');
    if (!notices && name === '@vscode/l10n@0.0.18')
      notices = await readFile(join(root, 'packages/runtime/VSCODE-L10N-LICENSE'), 'utf8');
    if (!notices) throw new Error(`Missing dependency license text: ${name}`);
    sections.push(`${name}\nLicense: ${manifest.license ?? 'See text below'}\n\n${notices}`);
  }
  await writeFile(
    join(output, 'THIRD-PARTY-NOTICES.txt'),
    sections.join('\n\n' + '='.repeat(72) + '\n\n'),
  );
  await copyFile(join(root, 'packages/runtime/NODE-LICENSE'), join(output, 'runtime/LICENSE'));
  return { name: 'node', version: process.version };
}
