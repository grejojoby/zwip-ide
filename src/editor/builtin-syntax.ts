import type { Extension } from '@codemirror/state';
import { StreamLanguage, type StreamParser } from '@codemirror/language';

type Loader = () => Promise<Extension>;
const stream =
  <State>(load: () => Promise<StreamParser<State>>): Loader =>
  async () =>
    StreamLanguage.define(await load());
const script =
  (typescript: boolean, jsx: boolean): Loader =>
  async () =>
    (await import('@codemirror/lang-javascript')).javascript({ typescript, jsx });

const go = stream(async () => (await import('@codemirror/legacy-modes/mode/go')).go);
const clike = <Name extends string>(name: Name) =>
  stream(async () => {
    const modes = await import('@codemirror/legacy-modes/mode/clike');
    return modes[name as keyof typeof modes] as StreamParser<unknown>;
  });
const shell = stream(async () => (await import('@codemirror/legacy-modes/mode/shell')).shell);
const yaml = stream(async () => (await import('@codemirror/legacy-modes/mode/yaml')).yaml);

/** Highlighting that works without any package installed. Enabled packages take precedence. */
const byExtension: Record<string, Loader> = {
  ts: script(true, false),
  mts: script(true, false),
  cts: script(true, false),
  tsx: script(true, true),
  js: script(false, false),
  mjs: script(false, false),
  cjs: script(false, false),
  jsx: script(false, true),
  html: async () => (await import('@codemirror/lang-html')).html(),
  htm: async () => (await import('@codemirror/lang-html')).html(),
  css: async () => (await import('@codemirror/lang-css')).css(),
  json: async () => (await import('@codemirror/lang-json')).json(),
  sql: async () => (await import('@codemirror/lang-sql')).sql(),
  go,
  py: stream(async () => (await import('@codemirror/legacy-modes/mode/python')).python),
  rs: stream(async () => (await import('@codemirror/legacy-modes/mode/rust')).rust),
  rb: stream(async () => (await import('@codemirror/legacy-modes/mode/ruby')).ruby),
  lua: stream(async () => (await import('@codemirror/legacy-modes/mode/lua')).lua),
  swift: stream(async () => (await import('@codemirror/legacy-modes/mode/swift')).swift),
  sh: shell,
  bash: shell,
  zsh: shell,
  ps1: stream(async () => (await import('@codemirror/legacy-modes/mode/powershell')).powerShell),
  yml: yaml,
  yaml,
  toml: stream(async () => (await import('@codemirror/legacy-modes/mode/toml')).toml),
  diff: stream(async () => (await import('@codemirror/legacy-modes/mode/diff')).diff),
  patch: stream(async () => (await import('@codemirror/legacy-modes/mode/diff')).diff),
  c: clike('c'),
  h: clike('c'),
  cpp: clike('cpp'),
  cc: clike('cpp'),
  hpp: clike('cpp'),
  java: clike('java'),
  cs: clike('csharp'),
  kt: clike('kotlin'),
  scala: clike('scala'),
  dart: clike('dart'),
};
const byName: Record<string, Loader> = {
  'go.mod': go,
  'go.work': go,
  dockerfile: stream(
    async () => (await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile,
  ),
  'cmakelists.txt': stream(async () => (await import('@codemirror/legacy-modes/mode/cmake')).cmake),
};

const baseName = (path: string) => (path.split(/[\\/]/).pop() ?? '').toLowerCase();
const extensionOf = (name: string) =>
  name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
/** Cache key: the whole name for name-matched files (go.mod), else the extension. */
export function builtinKey(path: string): string {
  const name = baseName(path);
  return name in byName ? name : extensionOf(name);
}
/** Returns null when the file type has no built-in grammar. */
export function builtinSyntax(path: string): Promise<Extension> | null {
  const name = baseName(path);
  return (byName[name] ?? byExtension[extensionOf(name)])?.() ?? null;
}
