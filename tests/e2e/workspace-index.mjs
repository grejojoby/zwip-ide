import { browser } from '@wdio/globals';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { writeFileSync, readFileSync, statSync, utimesSync, mkdirSync, existsSync } from 'node:fs';

const root = process.env.ZWIP_E2E_WORKSPACE;
const phase = process.env.ZWIP_INDEX_PHASE ?? 'cold';
const evidence = resolve('artifacts/workspace-index-restart.json');
const call = async (method, params = {}) => {
  const reply = await browser.executeAsync(
    (method, params, done) => {
      window.__TAURI__.core.invoke('ide_request', { method, params }).then(
        (result) => done({ result }),
        (error) => done({ error: String(error) }),
      );
    },
    method,
    params,
  );
  assert.ok(!reply.error, reply.error);
  return reply.result;
};
async function navigate(query) {
  const document = await call('document.open', { path: query.path });
  return call('navigation.query', { query: { ...query, documentRevision: document.revision } });
}
async function settled() {
  let status;
  await browser.waitUntil(
    async () => {
      status = await call('workspace.status');
      const failed = status.contexts.filter(
        (c) => c.state === 'failed' || c.indexState === 'failed',
      );
      assert.deepEqual(failed, [], JSON.stringify(failed));
      return (
        status.contexts.length >= 3 &&
        status.contexts.every((c) => ['built', 'restored'].includes(c.indexState))
      );
    },
    { timeout: 120000, timeoutMsg: 'Semantic workspace checkpoint did not settle.' },
  );
  return status;
}
// scripts/test-workspace-index.mjs runs this spec twice, with the same disposable
// data directory. The runner terminates the entire app between invocations.
describe('Persistent workspace semantic index', () => {
  it(`${phase}: validates Go profiles and web navigation across application processes`, async function () {
    this.timeout(240000);
    await browser.setTimeout({ script: 120000 });
    assert.ok(
      existsSync(join(root, '.zwip-e2e-fixture')),
      'Only a disposable acceptance workspace may be changed.',
    );
    if (phase === 'cold') {
      for (const id of ['go', 'web']) {
        await call('package.install', { path: resolve('dist/packages', id) });
        await call('package.enable', { id, enabled: true });
      }
      const start = Date.now();
      const workspace = await call('workspace.open', { root });
      await call('workspace.index');
      const built = await settled();
      assert.ok(built.contexts.some((c) => c.profileId === 'native-profile'));
      const query = {
        id: 'persist-web',
        operation: 'definition',
        path: join(root, 'consumer.ts'),
        position: { line: 1, character: 5 },
        documentRevision: 0,
        workspaceGeneration: workspace.generation,
      };
      const expected = await navigate(query);
      assert.equal(expected.state, 'complete');
      assert.ok(expected.locations.some((l) => l.path === join(root, 'types.ts')));
      await call('settings.set', { key: 'zwip.indexOnOpen', value: false });
      mkdirSync('artifacts', { recursive: true });
      writeFileSync(
        evidence,
        JSON.stringify(
          {
            root,
            coldMs: Date.now() - start,
            expected: expected.locations,
            query,
            epoch: workspace.index.epoch,
          },
          null,
          2,
        ),
      );
      return;
    }
    const before = JSON.parse(readFileSync(evidence, 'utf8'));
    assert.equal(before.root, root);
    const start = Date.now();
    const workspace = await call('workspace.open', { root });
    assert.equal(workspace.index.state, 'loaded');
    await call('workspace.restore');
    const loaded = await settled();
    const warmMs = Date.now() - start;
    assert.ok(
      loaded.contexts.every((c) => c.indexState === 'restored'),
      JSON.stringify(loaded),
    );
    assert.ok(
      loaded.contexts.filter((c) => c.language === 'go').every((c) => c.metadataRestored),
      JSON.stringify(loaded),
    );
    const actual = await navigate({ ...before.query, workspaceGeneration: workspace.generation });
    assert.deepEqual(actual.locations, before.expected);
    assert.equal(actual.state, 'complete');
    const source = join(root, 'types.ts');
    const text = readFileSync(source, 'utf8');
    const stat = statSync(source);
    try {
      writeFileSync(source, text.replace('Worker implements', 'Renamed implements'));
      utimesSync(source, stat.atime, stat.mtime);
      const changed = await call('workspace.open', { root });
      assert.equal(changed.index.state, 'built');
      await call('workspace.index');
      const fresh = await navigate({ ...before.query, workspaceGeneration: changed.generation });
      assert.ok(!fresh.locations.some((l) => l.path === source));
    } finally {
      writeFileSync(source, text);
    }
    const rebuilt = await call('workspace.refresh', { rebuildIndex: true });
    assert.notEqual(rebuilt.index.epoch, before.epoch);
    await call('workspace.index');
    await settled();
    writeFileSync(
      evidence,
      JSON.stringify(
        {
          ...before,
          warmMs,
          contexts: loaded.contexts.map(({ id, indexState, metadataRestored }) => ({
            id,
            indexState,
            metadataRestored,
          })),
        },
        null,
        2,
      ),
    );
  });
});
