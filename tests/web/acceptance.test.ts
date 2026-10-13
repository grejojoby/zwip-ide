import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { NavigationOperation, SourceLocation } from '../../src/contracts';
import { WebSemanticService } from '../../packages/web/src/service';

// Expected edges are hand-authored against these sources, not produced by an LS snapshot.
const files: Record<string, string> = {
  'a/model.ts': `export interface Runner { run(): number }
export interface Stoppable extends Runner { stop(): void }
export class Base implements Runner { run() { return 1 } }
export class Child extends Base implements Stoppable { stop() {} }
export class Grandchild extends Child {}
export const shape: Runner = { run() { return 2 } };
export function compute(value: number): number { return value * 2 }
export function overloaded(value: number): number;
export function overloaded(value: string): string;
export function overloaded(value: number | string) { return value }
export type Identity<T> = T;
export interface Box<T> { value: T }
export enum Status { Ready, Done }
export const uniqueValue = 42;
export namespace Group { export function nested() { return compute(1) } }
export function outer() { function local() { return compute(2) } return local() }
`,
  'a/barrel.ts': 'export * from "./model";\nexport { compute as calculate } from "./model";\n',
  'a/widget.tsx': `export interface WidgetProps { label: string }
export function Widget(props: WidgetProps) { return <div>{props.label}</div> }
declare global { namespace JSX { interface IntrinsicElements { div: { children?: unknown } } } }
`,
  'a/plain.js':
    '/** Doubles a number. @param {number} value */\nexport function double(value) { return value * 2 }\n',
  'b/use.tsx': `import { Runner, Base, Child, Grandchild, compute as aliased, overloaded, Identity, Box, Status, Group, uniqueValue } from "@model";
import { calculate } from "../a/barrel";
import { Widget, WidgetProps } from "../a/widget";
import { double } from "../a/plain";
export function consume(runner: Runner) { return runner.run() + aliased(1) }
export const viaBarrel = calculate(2);
export const viaOverload = overloaded("text");
export const instance = new Child();
export const generic: Box<Identity<Runner>> = { value: new Base() };
export const status = Status.Ready;
export const nested = Group.nested();
export const jsResult = double(2);
export const element = <Widget label="hello" />;
export const props: WidgetProps = { label: "hello" };
export const arrowCaller = () => aliased(3);
export class Caller { method() { return aliased(4) } }
export function shadow() { const uniqueValue = 7; return uniqueValue }
export const importedValue = uniqueValue;
`,
  'b/other.ts':
    'import { compute, Runner } from "../a/model";\nexport function other(value: Runner) { return compute(value.run()) }\n',
};
type Expected = { path: string; needle: string; occurrence?: number; relationship?: string };
type Case = {
  name: string;
  op: NavigationOperation;
  path: string;
  needle: string;
  occurrence?: number;
  expected: Expected[];
  absentNames?: string[];
};
const cases: Case[] = [
  {
    name: 'import alias resolves original function',
    op: 'definition',
    path: 'b/use.tsx',
    needle: 'aliased(1)',
    expected: [{ path: 'a/model.ts', needle: 'compute' }],
  },
  {
    name: 'barrel export alias resolves original function',
    op: 'definition',
    path: 'b/use.tsx',
    needle: 'calculate(2)',
    expected: [{ path: 'a/model.ts', needle: 'compute' }],
  },
  {
    name: 'path alias resolves class constructor',
    op: 'definition',
    path: 'b/use.tsx',
    needle: 'Child()',
    expected: [{ path: 'a/model.ts', needle: 'Child' }],
  },
  {
    name: 'overload call resolves selected declaration',
    op: 'definition',
    path: 'b/use.tsx',
    needle: 'overloaded("text")',
    expected: [{ path: 'a/model.ts', needle: 'overloaded', occurrence: 1 }],
  },
  {
    name: 'namespace property resolves nested declaration',
    op: 'definition',
    path: 'b/use.tsx',
    needle: 'nested()',
    expected: [{ path: 'a/model.ts', needle: 'nested' }],
  },
  {
    name: 'enum member resolves member declaration',
    op: 'definition',
    path: 'b/use.tsx',
    needle: 'Ready',
    expected: [{ path: 'a/model.ts', needle: 'Ready' }],
  },
  {
    name: 'JavaScript import resolves JSDoc function',
    op: 'definition',
    path: 'b/use.tsx',
    needle: 'double(2)',
    expected: [{ path: 'a/plain.js', needle: 'double' }],
  },
  {
    name: 'JSX component resolves TSX function',
    op: 'definition',
    path: 'b/use.tsx',
    needle: 'Widget label',
    expected: [{ path: 'a/widget.tsx', needle: 'Widget(', occurrence: 0 }],
  },
  {
    name: 'JSX attribute resolves prop declaration',
    op: 'definition',
    path: 'b/use.tsx',
    needle: 'label="hello"',
    expected: [{ path: 'a/widget.tsx', needle: 'label' }],
  },
  {
    name: 'shadowed variable resolves local instead of import',
    op: 'definition',
    path: 'b/use.tsx',
    needle: 'uniqueValue }',
    occurrence: 1,
    expected: [{ path: 'b/use.tsx', needle: 'uniqueValue = 7' }],
  },
  {
    name: 'unshadowed use resolves imported constant',
    op: 'definition',
    path: 'b/use.tsx',
    needle: 'uniqueValue;',
    expected: [{ path: 'a/model.ts', needle: 'uniqueValue' }],
  },
  {
    name: 'type definition resolves interface behind argument',
    op: 'typeDefinition',
    path: 'b/use.tsx',
    needle: 'runner.run',
    expected: [{ path: 'a/model.ts', needle: 'Runner' }],
  },
  {
    name: 'type definition resolves inferred class instance',
    op: 'typeDefinition',
    path: 'b/use.tsx',
    needle: 'instance',
    expected: [{ path: 'a/model.ts', needle: 'Child' }],
  },
  {
    name: 'generic variable type resolves generic interface',
    op: 'typeDefinition',
    path: 'b/use.tsx',
    needle: 'generic:',
    expected: [{ path: 'a/model.ts', needle: 'Box' }],
  },
  {
    name: 'TSX props type resolves imported interface',
    op: 'typeDefinition',
    path: 'b/use.tsx',
    needle: 'props:',
    expected: [{ path: 'a/widget.tsx', needle: 'WidgetProps' }],
  },
  {
    name: 'function references include unopened sibling',
    op: 'references',
    path: 'a/model.ts',
    needle: 'compute',
    expected: [{ path: 'b/other.ts', needle: 'compute(value.run())' }],
  },
  {
    name: 'interface references include unopened generic use',
    op: 'references',
    path: 'a/model.ts',
    needle: 'Runner',
    expected: [{ path: 'b/use.tsx', needle: 'Runner>>' }],
  },
  {
    name: 'component references include JSX use',
    op: 'references',
    path: 'a/widget.tsx',
    needle: 'Widget(',
    expected: [{ path: 'b/use.tsx', needle: 'Widget label' }],
  },
  {
    name: 'prop references include JSX attribute',
    op: 'references',
    path: 'a/widget.tsx',
    needle: 'label',
    expected: [{ path: 'b/use.tsx', needle: 'label="hello"' }],
  },
  {
    name: 'JavaScript references include TypeScript consumer',
    op: 'references',
    path: 'a/plain.js',
    needle: 'double',
    expected: [{ path: 'b/use.tsx', needle: 'double(2)' }],
  },
  {
    name: 'interface implementation includes concrete class',
    op: 'implementations',
    path: 'a/model.ts',
    needle: 'Runner',
    expected: [{ path: 'a/model.ts', needle: 'Base', relationship: 'implementation' }],
  },
  {
    name: 'interface method implementation includes concrete method',
    op: 'implementations',
    path: 'a/model.ts',
    needle: 'run()',
    expected: [
      { path: 'a/model.ts', needle: 'run()', occurrence: 1, relationship: 'implementation' },
    ],
  },
  {
    name: 'direct interface hierarchy excludes structural object',
    op: 'typeHierarchy',
    path: 'a/model.ts',
    needle: 'Runner',
    expected: [
      { path: 'a/model.ts', needle: 'Base', relationship: 'implementedBy' },
      { path: 'a/model.ts', needle: 'Stoppable', relationship: 'extendedBy' },
    ],
    absentNames: ['shape', 'Child', 'Grandchild'],
  },
  {
    name: 'class hierarchy exposes direct superclass and implemented interface',
    op: 'typeHierarchy',
    path: 'a/model.ts',
    needle: 'Child',
    expected: [
      { path: 'a/model.ts', needle: 'Base', relationship: 'extends' },
      { path: 'a/model.ts', needle: 'Stoppable', relationship: 'implements' },
      { path: 'a/model.ts', needle: 'Grandchild', relationship: 'extendedBy' },
    ],
  },
  {
    name: 'base hierarchy excludes transitive grandchild',
    op: 'typeHierarchy',
    path: 'a/model.ts',
    needle: 'Base',
    expected: [{ path: 'a/model.ts', needle: 'Child', relationship: 'extendedBy' }],
    absentNames: ['Grandchild'],
  },
  {
    name: 'incoming calls include imported function consumer',
    op: 'incomingCalls',
    path: 'a/model.ts',
    needle: 'compute',
    expected: [{ path: 'b/use.tsx', needle: 'consume', relationship: 'caller' }],
  },
  {
    name: 'incoming calls include arrow function consumer',
    op: 'incomingCalls',
    path: 'a/model.ts',
    needle: 'compute',
    expected: [{ path: 'b/use.tsx', needle: 'arrowCaller', relationship: 'caller' }],
  },
  {
    name: 'incoming calls include class method consumer',
    op: 'incomingCalls',
    path: 'a/model.ts',
    needle: 'compute',
    expected: [{ path: 'b/use.tsx', needle: 'method()', relationship: 'caller' }],
  },
  {
    name: 'outgoing calls include resolved imported alias',
    op: 'outgoingCalls',
    path: 'b/use.tsx',
    needle: 'consume',
    expected: [{ path: 'a/model.ts', needle: 'compute', relationship: 'callee' }],
  },
  {
    name: 'outgoing calls resolve function-local declarations',
    op: 'outgoingCalls',
    path: 'a/model.ts',
    needle: 'outer',
    expected: [{ path: 'a/model.ts', needle: 'local()', relationship: 'callee' }],
  },
];
function position(path: string, needle: string, occurrence = 0) {
  let offset = -1;
  for (let n = 0; n <= occurrence; n++) {
    offset = files[path].indexOf(needle, offset + 1);
    if (offset < 0) throw new Error(`Missing ${path}: ${needle} occurrence ${occurrence}`);
  }
  const before = files[path].slice(0, offset).split('\n');
  return { line: before.length - 1, character: before.at(-1)!.length };
}
let root: string;
let service: WebSemanticService;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'zwip-web-acceptance-')));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const contexts = ['a', 'b'].map((id) => {
    const configPath = join(root, id, 'tsconfig.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'commonjs',
          strict: true,
          noEmit: true,
          allowJs: true,
          jsx: 'preserve',
          baseUrl: '../a',
          paths: { '@model': ['model'] },
        },
        include: ['*.ts', '*.tsx', '*.js'],
      }),
    );
    return { id, root: join(root, id), configPath, language: 'web', state: 'loading' as const };
  });
  service = new WebSemanticService();
  service.initialize({ root, contexts, generation: 1 });
});
afterAll(() => {
  service?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
});
it.each(cases)('$name', async (test) => {
  const result = await service.query({
    id: test.name,
    operation: test.op,
    path: join(root, test.path),
    position: position(test.path, test.needle, test.occurrence),
    documentRevision: 0,
    workspaceGeneration: 1,
  });
  expect(result.state, result.reasons.join('; ')).toBe('complete');
  expect(result.searchedContexts).toBe(2);
  for (const wanted of test.expected) {
    const point = position(wanted.path, wanted.needle, wanted.occurrence);
    const matches = (location: SourceLocation) =>
      location.path === join(root, wanted.path) &&
      location.range.start.line === point.line &&
      location.range.start.character === point.character &&
      (!wanted.relationship || location.relationship === wanted.relationship);
    expect(
      result.locations.some(matches),
      JSON.stringify({ wanted, point, actual: result.locations }, null, 2),
    ).toBe(true);
  }
  for (const excluded of test.absentNames ?? [])
    expect(result.locations.some((location) => location.name === excluded)).toBe(false);
});
