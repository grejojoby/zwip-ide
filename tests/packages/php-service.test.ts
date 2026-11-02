import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhpService } from '../../packages/php/src/service';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'zwip-php-'));
  roots.push(root);
  const path = join(root, 'main.php');
  writeFileSync(path, '<?php function greet() {}\ngreet();');
  const service = new PhpService(process.env.ZWIP_PHP_BINARY ?? 'php');
  service.initialize({
    root,
    generation: 1,
    contexts: [
      {
        id: 'composer.json',
        root,
        configPath: join(root, 'composer.json'),
        language: 'php',
        state: 'loading',
      },
    ],
    files: [{ path }],
  });
  return { service, path, root };
}
const request = (path: string, operation: string, revision = 0) => ({
  id: 'q',
  path,
  operation,
  documentRevision: revision,
  workspaceGeneration: 1,
  position: { line: 1, character: 2 },
});
it('returns declaration candidates with explicit partial coverage and UTF-16 positions', () => {
  const { service, path } = setup();
  const result = service.query(request(path, 'definition'));
  expect(result.state).toBe('partial');
  expect(result.locations[0].name).toBe('greet');
  expect(result.locations[0].range.start).toEqual({ line: 0, character: 15 });
  expect(service.editor(request(path, 'symbols')).symbols).toHaveLength(1);
});
it('parses overlays without running PHP source, rejects stale revisions and closes overlays', () => {
  const { service, path } = setup();
  service.updateDocument({
    path,
    revision: 1,
    content: '<?php echo "MUST NOT EXECUTE"; function broken( {',
  });
  expect(service.editor(request(path, 'diagnostics', 1)).diagnostics?.[0].severity).toBe('error');
  expect(service.editor(request(path, 'symbols', 0)).state).toBe('failed');
  expect(() => service.updateDocument({ path, revision: 0, content: '' })).toThrow();
  service.closeDocument(path);
  expect(service.editor(request(path, 'diagnostics')).diagnostics).toEqual([]);
  expect(service.editor(request(path, 'rename')).state).toBe('unsupported');
});
it('fails explicitly for missing SDKs, external paths and stale generations', () => {
  const { service, path, root } = setup();
  expect(service.query({ ...request(path, 'definition'), workspaceGeneration: 2 }).state).toBe(
    'failed',
  );
  expect(() =>
    service.updateDocument({ path: join(root, '..', 'escape.php'), revision: 1, content: '' }),
  ).toThrow();
  const missing = new PhpService('/missing/php');
  expect(() => missing.initialize({ root, generation: 1, contexts: [], files: [] })).toThrow(/PHP/);
});
it('does not index files omitted by the host and refreshes included files after changes', () => {
  const { service, path, root } = setup();
  writeFileSync(join(root, 'excluded.php'), '<?php function hidden() {}');
  expect(
    service.workspaceSymbols({ id: 'w', query: 'hidden', workspaceGeneration: 1 }).locations,
  ).toEqual([]);
  writeFileSync(path, '<?php class Updated {}');
  service.workspaceChanged([path]);
  expect(
    service.workspaceSymbols({ id: 'w', query: 'Updated', workspaceGeneration: 1 }).locations[0]
      .name,
  ).toBe('Updated');
});
it('does not execute source and preserves Unicode UTF-16 ranges', () => {
  const { service, path, root } = setup();
  const marker = join(root, 'executed');
  const content = `<?php file_put_contents('${marker}', 'bad'); /* 😀 */ function café() {}`;
  service.updateDocument({ path, revision: 1, content });
  const result = service.editor({ ...request(path, 'symbols', 1), position: undefined });
  expect(result.symbols?.[0].name).toBe('café');
  expect(result.symbols?.[0].range).toEqual({
    start: { line: 0, character: content.indexOf('café') },
    end: { line: 0, character: content.indexOf('café') + 4 },
  });
  expect(service.editor(request(path, 'diagnostics', 1)).diagnostics).toEqual([]);
  expect(() => readFileSync(marker)).toThrow();
});
it('completes names, shows declaration previews and finds identifier occurrences without comments or strings', () => {
  const { service, path } = setup();
  const content = '<?php function greet() {}\ngreet(); // greet\n$s = "greet";\ngre';
  service.updateDocument({ path, content, revision: 1 });
  const completion = service.editor({
    ...request(path, 'completion', 1),
    position: { line: 3, character: 3 },
  });
  expect(completion.state).toBe('partial');
  expect(completion.completions?.find((c) => c.label === 'greet')?.insertText).toBe('greet');
  expect(service.editor(request(path, 'hover', 1)).hover).toContain('function greet');
  const references = service.query(request(path, 'references', 1));
  expect(references.state).toBe('partial');
  expect(references.locations).toHaveLength(2);
  expect(references.locations.map((l) => l.range.start.line)).toEqual([0, 1]);
});
