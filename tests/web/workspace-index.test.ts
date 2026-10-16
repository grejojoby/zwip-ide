import { afterEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  rmSync,
  readdirSync,
  readFileSync,
  utimesSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  WebIndexStore,
  directoryInputs,
  fileHash,
  hash,
  type WorkspaceIndex,
} from '../../packages/web/src/workspace-index';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zwip-index-store-')));
  roots.push(root);
  const cache = realpathSync(mkdtempSync(join(tmpdir(), 'zwip-index-cache-')));
  roots.push(cache);
  const source = join(root, 'main.ts');
  writeFileSync(source, 'const value = 1;');
  const store = new WebIndexStore(cache);
  const index: WorkspaceIndex = {
    schema: 1,
    root,
    identity: 'fixture',
    complete: true,
    files: { [source]: fileHash(source) },
    directories: directoryInputs(root),
    projects: [],
    values: {},
  };
  return { root, cache, source, store, index };
}
it('restores a complete checkpoint and rejects same-size offline edits despite preserved timestamps', () => {
  const { source, store, index, root } = fixture();
  store.save(index);
  expect(store.load(root, 'fixture')).toEqual(index);
  const before = statSync(source);
  writeFileSync(source, 'const value = 2;');
  utimesSync(source, before.atime, before.mtime);
  expect(store.load(root, 'fixture')).toBeNull();
});
it('invalidates offline additions, identity changes, and corrupt checkpoint contents', () => {
  const { store, index, root, cache } = fixture();
  store.save(index);
  expect(store.load(root, 'another-provider')).toBeNull();
  writeFileSync(join(root, 'added.ts'), 'export const added = 1');
  expect(store.load(root, 'fixture')).toBeNull();
  rmSync(join(root, 'added.ts'));
  const path = join(cache, 'workspace-index', hash(root), 'index.json');
  const body = JSON.parse(readFileSync(path, 'utf8'));
  body.data.identity = 'tampered';
  writeFileSync(path, JSON.stringify(body));
  expect(store.load(root, 'tampered')).toBeNull();
  expect(readdirSync(join(cache, 'workspace-index', hash(root)))).toEqual(['index.json']);
});
it('keeps the last complete snapshot when newer work has only partially checkpointed', () => {
  const { store, index, root } = fixture();
  store.save(index);
  store.save({ ...index, complete: false, identity: 'next' });
  expect(store.load(root, 'fixture')?.complete).toBe(true);
  expect(store.load(root, 'next')?.complete).toBe(false);
});
it('rejects changed dependencies and configuration, and preserves a published checkpoint after a failed write', () => {
  const { store, index, root, cache } = fixture();
  const config = join(root, 'tsconfig.json');
  writeFileSync(config, '{"compilerOptions":{}}');
  const current = {
    ...index,
    files: { ...index.files, [config]: fileHash(config) },
    directories: directoryInputs(root),
  };
  store.save(current);
  writeFileSync(config, '{"compilerOptions":{"strict":true}}');
  expect(store.load(root, 'fixture')).toBeNull();
  writeFileSync(config, '{"compilerOptions":{}}');
  // Occupy the partial target with a directory so atomic publication fails.
  const partial = join(cache, 'workspace-index', hash(root), 'partial.json');
  mkdirSync(partial);
  expect(() => store.save({ ...current, complete: false })).toThrow();
  expect(store.load(root, 'fixture')).toEqual(current);
});
it('isolates workspace roots and successive publishers without combining their snapshots', async () => {
  const { store, index, root, cache } = fixture();
  const other = fixture();
  const second = new WebIndexStore(cache);
  await Promise.all([
    Promise.resolve().then(() => store.save(index)),
    Promise.resolve().then(() => second.save({ ...index, identity: 'other-window' })),
    Promise.resolve().then(() => second.save({ ...other.index, identity: 'other-workspace' })),
  ]);
  expect(store.load(root, 'fixture')).toBeNull();
  expect(store.load(root, 'other-window')).toEqual({ ...index, identity: 'other-window' });
  expect(store.load(other.root, 'other-workspace')).toEqual({
    ...other.index,
    identity: 'other-workspace',
  });
});
