import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BuildContext, NavigationOperation, NavigationQuery } from '../../src/contracts';
import type { NavigationBatch } from '../../src/contracts';
import { WebSemanticService } from '../../packages/web/src/service';

const roots: string[] = [];
const services: WebSemanticService[] = [];

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zwip-web-')));
  roots.push(root);
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
      'export interface Service { run(): number }\nexport interface Extended extends Service { stop(): void }\nexport class Concrete implements Service { run() { return 1 } }\nexport const structural: Service = { run() { return 2 } };\nexport function work(): number { return 1 }\n',
    'b/use.ts':
      'import { Service, work } from "../a/model";\nexport function caller(value: Service) { return work() + value.run() }\n',
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
  services.push(service);
  service.initialize({ root, generation: 4, contexts });
  function query(
    operation: NavigationOperation,
    path: string,
    needle: string,
    offset = 0,
  ): NavigationQuery {
    const content = readFileSync(join(root, path), 'utf8');
    const before = content.slice(0, content.indexOf(needle) + offset);
    const lines = before.split('\n');
    return {
      id: 'q1',
      operation,
      path: join(root, path),
      position: { line: lines.length - 1, character: lines.at(-1)!.length },
      documentRevision: 0,
      workspaceGeneration: 4,
    };
  }
  return { root, service, query, contexts };
}

afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Web semantic provider', () => {
  it('reports unsupported custom build settings instead of silently ignoring them', async () => {
    const { service, root, contexts, query } = fixture();
    const initialized = service.initialize({
      root,
      generation: 4,
      contexts: [
        ...contexts,
        { ...contexts[0], id: 'a#custom', profileId: 'custom', settings: { target: 'other' } },
      ],
    });
    expect(initialized.contexts.find((context) => context.id === 'a#custom')).toMatchObject({
      state: 'failed',
      reason: expect.stringContaining('unsupported'),
    });
    const result = await service.query(query('references', 'a/model.ts', 'work'));
    expect(result.state).toBe('partial');
    expect(result.totalContexts).toBe(3);
    expect(result.reasons.join(' ')).toContain('unsupported');
  });
  it('streams immutable context progress and stops streaming after cancellation', async () => {
    const { service, query } = fixture();
    const batches: NavigationBatch[] = [];
    const final = await service.query(
      query('references', 'a/model.ts', 'work'),
      () => false,
      (batch) => batches.push(batch),
    );
    expect(batches.map((batch) => batch.searchedContexts)).toEqual([1, 2]);
    expect(batches.every((batch) => batch.state === 'loading')).toBe(true);
    expect(batches[0].locations.every((location) => location.contextIds.length === 1)).toBe(true);
    expect(batches[1].locations).toEqual(expect.arrayContaining(final.locations));
    const canceled: NavigationBatch[] = [];
    const result = await service.query(
      query('references', 'a/model.ts', 'work'),
      () => canceled.length > 0,
      (batch) => canceled.push(batch),
    );
    expect(canceled).toHaveLength(1);
    expect(result.state).toBe('canceled');
  });
  it('reports current context readiness and failures without rebuilding projects', async () => {
    const { root, contexts, service, query } = fixture();
    const ready = service.workspaceStatus();
    expect(ready.generation).toBe(4);
    expect(ready.contexts.map((context) => context.state)).toEqual(['ready', 'ready']);
    writeFileSync(join(root, 'b/tsconfig.json'), '{bad config');
    // Polling reports the initialized state; config refresh is an explicit host action.
    expect(service.workspaceStatus()).toEqual(ready);
    service.initialize({ root, contexts, generation: 5 });
    const failed = service.workspaceStatus();
    expect(failed.generation).toBe(5);
    expect(failed.contexts.map((context) => context.state)).toEqual(['ready', 'failed']);
    expect(failed.contexts[1].reason).toBeTruthy();
    expect(
      (
        await service.query({
          ...query('definition', 'a/model.ts', 'Service'),
          workspaceGeneration: 5,
        })
      ).state,
    ).toBe('partial');
  });

  it('navigates loaded external dependency sources while rejecting outside overlays', async () => {
    const { root, contexts, service } = fixture();
    const dependency = realpathSync(mkdtempSync(join(tmpdir(), 'zwip-web-dependency-')));
    roots.push(dependency);
    writeFileSync(
      join(dependency, 'package.json'),
      JSON.stringify({ name: 'external-nav', version: '1.0.0', types: 'index.d.ts' }),
    );
    const base = 'export interface Base { run(): void }\n';
    const declaration =
      'import { Base } from "./base";\nexport interface Extended extends Base { stop(): void }\nexport { Base };\n';
    writeFileSync(join(dependency, 'base.d.ts'), base);
    writeFileSync(join(dependency, 'index.d.ts'), declaration);
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    symlinkSync(dependency, join(root, 'node_modules/external-nav'), 'dir');
    writeFileSync(
      join(root, 'a/external.ts'),
      'import { Base } from "external-nav";\nexport interface WorkspaceChild extends Base { extra(): void }\n',
    );
    writeFileSync(
      join(root, 'b/external.ts'),
      'import { Extended } from "external-nav";\nexport function consume(value: Extended) { value.stop() }\n',
    );
    service.initialize({ root, contexts, generation: 4 });
    const request: NavigationQuery = {
      id: 'external',
      operation: 'definition',
      path: join(dependency, 'index.d.ts'),
      position: { line: 1, character: declaration.split('\n')[1].lastIndexOf('Base') },
      documentRevision: 0,
      workspaceGeneration: 4,
    };
    const definition = await service.query(request);
    expect(definition.state).toBe('complete');
    expect(
      definition.locations.map((location) => ({
        path: location.path,
        line: location.range.start.line,
        character: location.range.start.character,
        contexts: location.contextIds,
      })),
    ).toEqual([
      { path: join(dependency, 'base.d.ts'), line: 0, character: 17, contexts: ['a', 'b'] },
    ]);
    const baseRequest = {
      ...request,
      path: join(dependency, 'base.d.ts'),
      position: { line: 0, character: 17 },
    };
    const references = await service.query({ ...baseRequest, operation: 'references' });
    expect(references.state).toBe('complete');
    expect(
      references.locations
        .filter((location) => location.path === join(root, 'a/external.ts'))
        .map((location) => location.range.start),
    ).toEqual([
      { line: 0, character: 9 },
      { line: 1, character: 40 },
    ]);
    const hierarchy = await service.query({ ...baseRequest, operation: 'typeHierarchy' });
    expect(hierarchy.state).toBe('complete');
    expect(
      hierarchy.locations.map((location) => [location.name, location.relationship, location.path]),
    ).toEqual(
      expect.arrayContaining([
        ['Extended', 'extendedBy', join(dependency, 'index.d.ts')],
        ['WorkspaceChild', 'extendedBy', join(root, 'a/external.ts')],
      ]),
    );
    expect(() =>
      service.updateDocument({ path: request.path, content: declaration, revision: 1 }),
    ).toThrow('outside this workspace');
    expect(readFileSync(request.path, 'utf8')).toBe(declaration);
    writeFileSync(join(dependency, 'unrelated.ts'), 'export const other = 1;');
    expect(
      (await service.query({ ...baseRequest, path: join(dependency, 'unrelated.ts') })).state,
    ).toBe('failed');
  });

  it('finds references in an unopened sibling project with context provenance', async () => {
    const { root, service, query } = fixture();
    const result = await service.query(query('references', 'a/model.ts', 'Service'));
    expect(result.state).toBe('complete');
    expect(result.searchedContexts).toBe(2);
    expect(result.totalContexts).toBe(2);
    expect(
      result.locations.some(
        (location) => location.path === join(root, 'b/use.ts') && location.contextIds.includes('b'),
      ),
    ).toBe(true);
    expect(
      result.locations.filter(
        (location) => location.path === join(root, 'a/model.ts') && location.range.start.line === 0,
      ),
    ).toHaveLength(1);
  });

  it('resolves definitions and type definitions through imports', async () => {
    const { root, service, query } = fixture();
    const definition = await service.query(query('definition', 'b/use.ts', 'work()'));
    expect(
      definition.locations.some(
        (location) => location.path === join(root, 'a/model.ts') && location.name === 'work',
      ),
    ).toBe(true);
    const type = await service.query(query('typeDefinition', 'b/use.ts', 'value.run'));
    expect(
      type.locations.some(
        (location) => location.path === join(root, 'a/model.ts') && location.name === 'Service',
      ),
    ).toBe(true);
  });

  it('keeps explicit inheritance separate from structural compatibility', async () => {
    const { service, query } = fixture();
    const result = await service.query(query('typeHierarchy', 'a/model.ts', 'Service'));
    expect(result.state).toBe('complete');
    expect(result.locations.map((location) => [location.name, location.relationship])).toEqual(
      expect.arrayContaining([
        ['Concrete', 'implementedBy'],
        ['Extended', 'extendedBy'],
      ]),
    );
    expect(result.locations.some((location) => location.name === 'structural')).toBe(false);
    const implementations = await service.query(query('implementations', 'a/model.ts', 'Service'));
    expect(implementations.locations.some((location) => location.name === 'Concrete')).toBe(true);
  });

  it('finds incoming and outgoing calls across project contexts', async () => {
    const { service, query } = fixture();
    const incoming = await service.query(query('incomingCalls', 'a/model.ts', 'work'));
    expect(
      incoming.locations.some(
        (location) => location.name === 'caller' && location.relationship === 'caller',
      ),
    ).toBe(true);
    const outgoing = await service.query(query('outgoingCalls', 'b/use.ts', 'caller'));
    expect(
      outgoing.locations.some(
        (location) => location.name === 'work' && location.relationship === 'callee',
      ),
    ).toBe(true);
  });

  it('uses unsaved overlays and rejects stale query revisions', async () => {
    const { root, service, query } = fixture();
    const request = query('references', 'b/use.ts', 'work()');
    service.updateDocument({
      path: join(root, 'b/use.ts'),
      content:
        'import { work } from "../a/model";\nexport function replacement() { return work() + work() }\n',
      revision: 2,
    });
    expect((await service.query(request)).state).toBe('failed');
    const updated = await service.query({
      ...request,
      position: { line: 1, character: 39 },
      documentRevision: 2,
    });
    expect(updated.documentRevision).toBe(2);
    expect(
      updated.locations.filter(
        (location) => location.path === join(root, 'b/use.ts') && location.range.start.line === 1,
      ),
    ).toHaveLength(2);
  });

  it('reports broken configurations as incomplete coverage', async () => {
    const { root, service, query, contexts } = fixture();
    writeFileSync(join(root, 'b/tsconfig.json'), '{ broken json');
    service.initialize({ root, generation: 4, contexts });
    const result = await service.query(query('references', 'a/model.ts', 'Service'));
    expect(result.state).toBe('partial');
    expect(result.searchedContexts).toBe(1);
    expect(result.totalContexts).toBe(2);
    expect(result.reasons.join(' ')).toContain('b');
  });

  it('reports unresolved imports as partial rather than complete-empty results', async () => {
    const { root, service } = fixture();
    service.updateDocument({
      path: join(root, 'b/use.ts'),
      content:
        'import { Missing } from "./not-installed";\nexport const value: Missing = {} as Missing;\n',
      revision: 1,
    });
    const result = await service.query({
      id: 'unresolved',
      operation: 'definition',
      path: join(root, 'b/use.ts'),
      position: { line: 1, character: 20 },
      documentRevision: 1,
      workspaceGeneration: 4,
    });
    expect(result.state).toBe('partial');
    expect(result.reasons.join(' ')).toContain('not-installed');
  });

  it('rejects obsolete workspace generations and unknown operations honestly', async () => {
    const { service, query } = fixture();
    const request = query('definition', 'a/model.ts', 'Service');
    expect((await service.query({ ...request, workspaceGeneration: 1 })).state).toBe('failed');
    expect(
      (await service.query({ ...request, operation: 'rename' as NavigationOperation })).state,
    ).toBe('unsupported');
  });

  it('honors cancellation without reporting a successful empty search', async () => {
    const { service, query } = fixture();
    const result = await service.query(query('references', 'a/model.ts', 'Service'), () => true);
    expect(result.state).toBe('canceled');
  });
});

describe('workspace symbol search without an editor tab', () => {
  it('searches all unopened projects and merges shared declaration provenance', async () => {
    const { root, service } = fixture();
    const result = await service.workspaceSymbols({
      id: 'symbols',
      query: 'work',
      workspaceGeneration: 4,
    });
    expect(result.documentRevision).toBe(0);
    expect(result.state).toBe('complete');
    expect(result.searchedContexts).toBe(2);
    expect(
      result.locations.filter(
        (item) => item.path === join(root, 'a/model.ts') && item.name === 'work',
      ),
    ).toHaveLength(1);
    const sibling = await service.workspaceSymbols({
      id: 'sibling',
      query: 'caller',
      workspaceGeneration: 4,
    });
    expect(
      sibling.locations.some(
        (item) => item.path === join(root, 'b/use.ts') && item.name === 'caller',
      ),
    ).toBe(true);
  });
  it('reports failed project coverage and cancellation honestly', async () => {
    const { root, service, contexts } = fixture();
    writeFileSync(join(root, 'b/tsconfig.json'), '{bad');
    service.initialize({ root, contexts, generation: 4 });
    const result = await service.workspaceSymbols({
      id: 'partial',
      query: 'work',
      workspaceGeneration: 4,
    });
    expect(result.state).toBe('partial');
    expect(result.searchedContexts).toBe(1);
    expect(result.totalContexts).toBe(2);
    expect(result.reasons.join(' ')).toContain('b');
    expect(
      (
        await service.workspaceSymbols(
          { id: 'cancel', query: 'work', workspaceGeneration: 4 },
          () => true,
        )
      ).state,
    ).toBe('canceled');
    expect(
      (await service.workspaceSymbols({ id: 'stale', query: 'work', workspaceGeneration: 3 }))
        .state,
    ).toBe('failed');
  });
});
