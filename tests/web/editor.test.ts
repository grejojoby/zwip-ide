import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BuildContext, EditorOperation, EditorRequest } from '../../src/contracts';
import { WebSemanticService } from '../../packages/web/src/service';

const cleanups: (() => void)[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zwip-web-editor-')));
  const files: Record<string, string> = {
    'a/tsconfig.json': JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2022', module: 'commonjs' },
      include: ['*.ts'],
    }),
    'b/tsconfig.json': JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2022', module: 'commonjs' },
      include: ['*.ts'],
    }),
    'a/model.ts':
      '/** Does the work. */\nexport function work(): number { return 1 }\nexport const existing = 1;\n',
    'b/use.ts': 'import { work } from "../a/model";\nexport const value = work();\n',
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const contexts: BuildContext[] = ['a', 'b'].map((id) => ({
    id,
    root: join(root, id),
    language: 'web',
    configPath: join(root, id, 'tsconfig.json'),
    state: 'loading',
  }));
  const service = new WebSemanticService();
  service.initialize({ root, generation: 4, contexts });
  cleanups.push(() => {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  const request = (
    operation: EditorOperation,
    path = 'a/model.ts',
    extra: Partial<EditorRequest> = {},
  ): EditorRequest => ({
    id: 'editor',
    operation,
    path: join(root, path),
    position: { line: 1, character: 17 },
    documentRevision: 0,
    workspaceGeneration: 4,
    ...extra,
  });
  return { root, service, contexts, request };
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

it('provides typed hover, document symbols, and workspace symbols', async () => {
  const { service, request } = fixture();
  const hover = await service.editor(request('hover'));
  expect(hover.state).toBe('complete');
  expect(hover.hover).toContain('work(): number');
  expect(hover.hover).toContain('Does the work.');
  const symbols = await service.editor(request('symbols'));
  expect(symbols.symbols?.map((symbol) => symbol.name)).toContain('work');
  const workspace = await service.editor(request('symbols', 'a/model.ts', { query: 'value' }));
  expect(
    workspace.symbols?.some(
      (symbol) => symbol.path.endsWith('/b/use.ts') && symbol.name === 'value',
    ),
  ).toBe(true);
});

it('completion and diagnostics use unsaved text and exact revision', async () => {
  const { root, service, request } = fixture();
  service.updateDocument({
    path: join(root, 'a/model.ts'),
    revision: 2,
    content: 'export const item = { run: () => 1 };\nitem.\n',
  });
  expect((await service.editor(request('completion'))).state).toBe('failed');
  const completion = await service.editor(
    request('completion', 'a/model.ts', {
      documentRevision: 2,
      position: { line: 1, character: 5 },
    }),
  );
  expect(
    completion.completions?.some((item) => item.label === 'run' && item.insertText === 'run'),
  ).toBe(true);
  const diagnostics = await service.editor(
    request('diagnostics', 'a/model.ts', { documentRevision: 2, position: undefined }),
  );
  expect(diagnostics.diagnostics?.some((item) => item.severity === 'error')).toBe(true);
});

it('returns reviewed formatting and import action edits without writing files', async () => {
  const { root, service, request } = fixture();
  const original = readFileSync(join(root, 'a/model.ts'), 'utf8');
  const overlay = 'export const answer={value:1};\n';
  service.updateDocument({ path: join(root, 'a/model.ts'), revision: 1, content: overlay });
  const formatting = await service.editor(
    request('format', 'a/model.ts', { documentRevision: 1, position: undefined }),
  );
  expect(formatting.state).toBe('complete');
  expect(formatting.edits?.length).toBeGreaterThan(0);
  expect(
    formatting.edits?.every(
      (edit) =>
        edit.revision === 1 && edit.fileHash === createHash('sha256').update(overlay).digest('hex'),
    ),
  ).toBe(true);
  expect(readFileSync(join(root, 'a/model.ts'), 'utf8')).toBe(original);
  service.updateDocument({
    path: join(root, 'b/use.ts'),
    revision: 1,
    content: 'import { answer } from "../a/model";\nexport const value = 1;\n',
  });
  const actions = await service.editor(
    request('codeActions', 'b/use.ts', {
      documentRevision: 1,
      position: { line: 1, character: 0 },
    }),
  );
  expect(
    actions.codeActions?.some(
      (action) => action.kind === 'source.organizeImports' && action.edits.length,
    ),
  ).toBe(true);
});

it('rename includes unopened sibling consumers with content preconditions', async () => {
  const { root, service, request } = fixture();
  const before = readFileSync(join(root, 'b/use.ts'), 'utf8');
  const result = await service.editor(request('rename', 'a/model.ts', { newName: 'perform' }));
  expect(result.state, result.reasons.join('; ')).toBe('complete');
  expect(
    result.edits?.some(
      (edit) => edit.path === join(root, 'b/use.ts') && edit.newText === 'perform',
    ),
  ).toBe(true);
  expect(
    result.edits?.every((edit) => edit.revision === 0 && /^[a-f0-9]{64}$/.test(edit.fileHash!)),
  ).toBe(true);
  expect(readFileSync(join(root, 'b/use.ts'), 'utf8')).toBe(before);
});

it('rename rejects conflicts and incomplete project coverage without returning edits', async () => {
  const { root, service, contexts, request } = fixture();
  const conflict = await service.editor(request('rename', 'a/model.ts', { newName: 'existing' }));
  expect(conflict.state).toBe('failed');
  expect(conflict.edits).toBeUndefined();
  expect(conflict.reasons.join(' ')).toContain('diagnostic');
  expect((await service.editor(request('hover'))).hover).toContain('work(): number');
  writeFileSync(join(root, 'b/tsconfig.json'), '{invalid');
  service.initialize({ root, contexts, generation: 4 });
  const partial = await service.editor(request('rename', 'a/model.ts', { newName: 'perform' }));
  expect(partial.state).toBe('failed');
  expect(partial.edits).toBeUndefined();
});

it('disk notifications add unopened files and preserve unsaved overlays', async () => {
  const { root, service, request } = fixture();
  service.updateDocument({
    path: join(root, 'b/use.ts'),
    revision: 3,
    content: 'import { work } from "../a/model";\nexport const unsaved = work();\n',
  });
  const newPath = join(root, 'b/new.ts');
  writeFileSync(newPath, 'import { work } from "../a/model";\nexport const added = work();\n');
  service.workspaceChanged([newPath]);
  const rename = await service.editor(request('rename', 'a/model.ts', { newName: 'perform' }));
  expect(rename.state, rename.reasons.join('; ')).toBe('complete');
  expect(rename.edits?.some((edit) => edit.path === newPath)).toBe(true);
  expect(
    rename.edits?.some((edit) => edit.path === join(root, 'b/use.ts') && edit.revision === 3),
  ).toBe(true);
  const symbols = await service.editor(request('symbols', 'b/use.ts', { documentRevision: 3 }));
  expect(symbols.symbols?.some((symbol) => symbol.name === 'unsaved')).toBe(true);
});

it('closing a document releases its overlay and reloads disk for later queries', async () => {
  const { root, service, request } = fixture();
  const path = join(root, 'a/model.ts');
  service.updateDocument({
    path,
    revision: 8,
    content: 'export function temporary() { return 2 }\n',
  });
  expect(
    (
      await service.editor(
        request('symbols', 'a/model.ts', { documentRevision: 8, position: undefined }),
      )
    ).symbols?.some((item) => item.name === 'temporary'),
  ).toBe(true);
  expect(service.closeDocument(path).revision).toBe(0);
  const symbols = await service.editor(request('symbols'));
  expect(symbols.state).toBe('complete');
  expect(symbols.symbols?.some((item) => item.name === 'work')).toBe(true);
  expect(symbols.symbols?.some((item) => item.name === 'temporary')).toBe(false);
  service.updateDocument({
    path,
    revision: 1,
    content: 'export function reopened() { return 3 }\n',
  });
  expect(
    (
      await service.editor(
        request('symbols', 'a/model.ts', { documentRevision: 1, position: undefined }),
      )
    ).symbols?.some((item) => item.name === 'reopened'),
  ).toBe(true);
});
