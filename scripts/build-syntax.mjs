import { build } from 'esbuild';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
const modules = JSON.parse(
  await readFile(new URL('../packages/syntax/runtime-modules.json', import.meta.url), 'utf8'),
);
/** The package owns its grammar; host primitives share the editor's CM instances. */
export async function buildSyntax(entry, output) {
  const exports = Object.fromEntries(
    await Promise.all(modules.map(async (name) => [name, Object.keys(await import(name))])),
  );
  const result = await build({
    entryPoints: [entry],
    outfile: join(output, 'syntax.mjs'),
    platform: 'browser',
    format: 'esm',
    bundle: true,
    minify: true,
    metafile: true,
    target: 'safari16',
    plugins: [
      {
        name: 'zwip-syntax-abi',
        setup(build) {
          build.onResolve({ filter: /^(?:@codemirror|@lezer)\// }, (args) =>
            modules.includes(args.path) ? { path: args.path, namespace: 'host-abi' } : null,
          );
          build.onLoad({ filter: /.*/, namespace: 'host-abi' }, (args) => ({
            contents: exports[args.path]
              .map(
                (name) =>
                  `export const ${name}=globalThis.__zwipSyntaxRuntime[${JSON.stringify(args.path)}][${JSON.stringify(name)}];`,
              )
              .join('\n'),
            loader: 'js',
          }));
        },
      },
    ],
  });
  const dependencies = new Map();
  for (const input of Object.keys(result.metafile.inputs)) {
    const match = input.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
    if (match) dependencies.set(match[1], dirname(resolve(input)));
  }
  const notices = [];
  for (const [name, initial] of [...dependencies].sort(([a], [b]) => a.localeCompare(b))) {
    let directory = initial;
    while (!(await readdir(directory)).includes('package.json')) directory = dirname(directory);
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    const files = (await readdir(directory)).filter((file) => /^(licen[sc]e|notice)/i.test(file));
    if (!files.length) throw new Error(`Missing syntax dependency notice: ${name}`);
    notices.push(
      `${name}@${manifest.version}\n\n${(await Promise.all(files.map((file) => readFile(join(directory, file), 'utf8')))).join('\n')}`,
    );
  }
  await writeFile(join(output, 'SYNTAX-NOTICES.txt'), notices.join('\n\n'));
  return result.metafile;
}
