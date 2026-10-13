import { afterEach, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WebSemanticService } from '../../packages/web/src/service';
import type { BuildContext, EditorOperation } from '../../src/contracts';

const cleanups: (() => void)[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zwip-web-framework-')));
  const service = new WebSemanticService();
  cleanups.push(() => {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const request = (operation: EditorOperation, path: string, character = 0) => ({
    id: 'framework',
    operation,
    path: join(root, path),
    position: { line: 0, character },
    documentRevision: 0,
    workspaceGeneration: 1,
  });
  return { root, service, write, request };
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

it('runs the real project Next plugin and isolates apps sharing one installed package', async () => {
  const { root, service, write, request } = fixture();
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(
    dirname(createRequire(import.meta.url).resolve('next/package.json')),
    join(root, 'node_modules/next'),
    'dir',
  );
  const contexts: BuildContext[] = ['a', 'b'].map((id) => ({
    id,
    root: join(root, id),
    configPath: join(root, id, 'tsconfig.json'),
    language: 'web',
    state: 'loading',
  }));
  for (const id of ['a', 'b'])
    write(
      `${id}/tsconfig.json`,
      JSON.stringify({
        compilerOptions: { target: 'ES2022', plugins: [{ name: 'next' }] },
        include: ['app/**/*.ts'],
      }),
    );
  write(
    'a/app/page.ts',
    'export const dynamic = "invalid-fixture-value";\nexport default function Page() { return null }\n',
  );
  write(
    'b/app/page.ts',
    'export const revalidate = -1;\nexport default function Page() { return null }\n',
  );
  const initialized = service.initialize({
    root,
    contexts,
    generation: 1,
    enabledPackages: ['web', 'react-next'],
  });
  expect(
    initialized.contexts.every((context) =>
      context.plugins.some((plugin) => plugin.name === 'next' && plugin.state === 'active'),
    ),
  ).toBe(true);
  for (const id of ['a', 'b', 'a']) {
    const result = await service.editor(request('diagnostics', `${id}/app/page.ts`));
    expect(result.state, result.reasons.join('; ')).toBe('complete');
    expect(
      result.diagnostics?.some((diagnostic) =>
        diagnostic.message.includes(id === 'a' ? 'dynamic' : 'revalidate'),
      ),
    ).toBe(true);
  }
  const hover = await service.editor(request('hover', 'a/app/page.ts', 14));
  expect(hover.hover).toContain('dynamic');
  expect(hover.hover).toContain('https://nextjs.org/');
});

it('reports missing configured plugins instead of silently dropping framework behavior', async () => {
  const { root, service, write, request } = fixture();
  write(
    'tsconfig.json',
    JSON.stringify({ compilerOptions: { plugins: [{ name: 'next' }] }, include: ['*.ts'] }),
  );
  write('main.ts', 'export const value = 1;');
  const initialized = service.initialize({
    root,
    contexts: [
      {
        id: 'app',
        root,
        configPath: join(root, 'tsconfig.json'),
        language: 'web',
        state: 'loading',
      },
    ],
    generation: 1,
    enabledPackages: ['web', 'react-next'],
  });
  expect(initialized.contexts[0].plugins[0].state).toBe('failed');
  const result = await service.editor(request('diagnostics', 'main.ts'));
  expect(result.state).toBe('partial');
  expect(result.reasons.join('; ')).toContain('Next.js');
});

it('does not load the Next project plugin while its feature package is disabled', async () => {
  const { root, service, write, request } = fixture();
  write(
    'tsconfig.json',
    JSON.stringify({ compilerOptions: { plugins: [{ name: 'next' }] }, include: ['*.ts'] }),
  );
  write('main.ts', 'export const value = 1;');
  const initialized = service.initialize({
    root,
    contexts: [
      {
        id: 'app',
        root,
        configPath: join(root, 'tsconfig.json'),
        language: 'web',
        state: 'loading',
      },
    ],
    generation: 1,
    enabledPackages: ['web'],
  });
  expect(initialized.contexts[0].plugins[0].state).toBe('disabled');
  const result = await service.editor(request('diagnostics', 'main.ts'));
  expect(result.state).toBe('partial');
  expect(result.reasons.join('; ')).toContain('React / Next.js package');
});

it('resolves and renames React-style TSX components in unopened consumers', async () => {
  const { root, service, write, request } = fixture();
  write(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: { strict: true, jsx: 'preserve' },
      include: ['*.tsx', '*.d.ts'],
    }),
  );
  write('jsx.d.ts', 'declare namespace JSX { interface IntrinsicElements { div: {} } }');
  write('components.tsx', 'export function Card() { return <div />; }');
  write('consumer.tsx', 'import { Card } from "./components";\nexport const view = <Card />;');
  service.initialize({
    root,
    contexts: [
      {
        id: 'app',
        root,
        configPath: join(root, 'tsconfig.json'),
        language: 'web',
        state: 'loading',
      },
    ],
    generation: 1,
  });
  const references = await service.query({
    id: 'jsx',
    operation: 'references',
    path: join(root, 'components.tsx'),
    position: { line: 0, character: 17 },
    documentRevision: 0,
    workspaceGeneration: 1,
  });
  expect(references.state, references.reasons.join('; ')).toBe('complete');
  expect(
    references.locations.some(
      (location) => location.path.endsWith('/consumer.tsx') && location.range.start.line === 1,
    ),
  ).toBe(true);
  const rename = await service.editor({
    ...request('rename', 'components.tsx', 17),
    newName: 'Panel',
  });
  expect(rename.state, rename.reasons.join('; ')).toBe('complete');
  expect(rename.edits?.filter((edit) => edit.path.endsWith('/consumer.tsx'))).toHaveLength(2);
});

it('provides HTML completion, hover, formatting and paired tag rename with honest gaps', async () => {
  const { root, service, write, request } = fixture();
  write('page.html', '<div><span>value</span></div>');
  write('complete.html', '<di');
  service.initialize({ root, contexts: [], generation: 1 });
  const completion = await service.editor(request('completion', 'complete.html', 3));
  expect(completion.completions?.some((item) => item.label === 'div')).toBe(true);
  const hover = await service.editor(request('hover', 'page.html', 2));
  expect(hover.hover).toContain('div');
  const format = await service.editor(request('format', 'page.html'));
  expect(format.edits?.length).toBeGreaterThan(0);
  const rename = await service.editor({ ...request('rename', 'page.html', 2), newName: 'section' });
  expect(rename.state).toBe('complete');
  expect(rename.edits).toHaveLength(2);
  expect(
    rename.edits?.every((edit) => edit.newText === 'section' && edit.fileHash?.length === 64),
  ).toBe(true);
  expect((await service.editor(request('diagnostics', 'page.html'))).state).toBe('unsupported');
});

it('provides CSS diagnostics, completion, symbols, formatting and file-scoped navigation', async () => {
  const { root, service, write, request } = fixture();
  write('style.css', ':root { --brand: red; }\n.item { color: var(--brand); unknown-fixture: 1; }');
  write('complete.css', '.item { col }');
  service.initialize({ root, contexts: [], generation: 1 });
  const completion = await service.editor(request('completion', 'complete.css', 11));
  expect(completion.completions?.some((item) => item.label === 'color')).toBe(true);
  const diagnostics = await service.editor(request('diagnostics', 'style.css'));
  expect(diagnostics.diagnostics?.some((item) => item.message.includes('unknown-fixture'))).toBe(
    true,
  );
  const symbols = await service.editor(request('symbols', 'style.css'));
  expect(symbols.symbols?.some((item) => item.name.includes('.item'))).toBe(true);
  expect((await service.editor(request('format', 'style.css'))).edits?.length).toBeGreaterThan(0);
  const navigation = await service.query({
    id: 'css',
    operation: 'definition',
    path: join(root, 'style.css'),
    position: { line: 1, character: 22 },
    documentRevision: 0,
    workspaceGeneration: 1,
  });
  expect(navigation.state).toBe('partial');
  expect(navigation.locations.length).toBeGreaterThan(0);
  expect(navigation.reasons.join('; ')).toContain('current document only');
  expect(
    (await service.editor({ ...request('rename', 'style.css'), newName: 'changed' })).state,
  ).toBe('unsupported');
});
