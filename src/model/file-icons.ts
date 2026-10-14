/** The icon family and tint used for a file, chosen from its name like IntelliJ's file types. */
export type FileIconShape =
  | 'code'
  | 'braces'
  | 'config'
  | 'text'
  | 'image'
  | 'terminal'
  | 'lock'
  | 'archive'
  | 'container'
  | 'database'
  | 'media'
  | 'plain';

export interface FileIconKind {
  shape: FileIconShape;
  /** Tint key; styled by `.file-icon[data-type]` in styles.css. */
  type: string;
}

const byName: Record<string, FileIconKind> = {
  'go.mod': { shape: 'config', type: 'go' },
  'go.work': { shape: 'config', type: 'go' },
  'go.sum': { shape: 'lock', type: 'lock' },
  'go.work.sum': { shape: 'lock', type: 'lock' },
  'package-lock.json': { shape: 'lock', type: 'lock' },
  'yarn.lock': { shape: 'lock', type: 'lock' },
  'pnpm-lock.yaml': { shape: 'lock', type: 'lock' },
  'cargo.lock': { shape: 'lock', type: 'lock' },
  dockerfile: { shape: 'container', type: 'docker' },
  makefile: { shape: 'terminal', type: 'shell' },
  '.gitignore': { shape: 'config', type: 'git' },
  '.gitattributes': { shape: 'config', type: 'git' },
  '.gitmodules': { shape: 'config', type: 'git' },
  '.env': { shape: 'config', type: 'config' },
};

const byExtension: Record<string, FileIconKind> = {
  go: { shape: 'code', type: 'go' },
  ts: { shape: 'code', type: 'ts' },
  tsx: { shape: 'code', type: 'ts' },
  mts: { shape: 'code', type: 'ts' },
  cts: { shape: 'code', type: 'ts' },
  js: { shape: 'code', type: 'js' },
  jsx: { shape: 'code', type: 'js' },
  mjs: { shape: 'code', type: 'js' },
  cjs: { shape: 'code', type: 'js' },
  rs: { shape: 'code', type: 'rust' },
  py: { shape: 'code', type: 'python' },
  java: { shape: 'code', type: 'java' },
  kt: { shape: 'code', type: 'java' },
  c: { shape: 'code', type: 'c' },
  h: { shape: 'code', type: 'c' },
  cc: { shape: 'code', type: 'c' },
  cpp: { shape: 'code', type: 'c' },
  hpp: { shape: 'code', type: 'c' },
  swift: { shape: 'code', type: 'swift' },
  rb: { shape: 'code', type: 'ruby' },
  php: { shape: 'code', type: 'php' },
  html: { shape: 'code', type: 'html' },
  htm: { shape: 'code', type: 'html' },
  xml: { shape: 'code', type: 'html' },
  svg: { shape: 'image', type: 'image' },
  css: { shape: 'code', type: 'css' },
  scss: { shape: 'code', type: 'css' },
  less: { shape: 'code', type: 'css' },
  proto: { shape: 'code', type: 'config' },
  http: { shape: 'code', type: 'http' },
  json: { shape: 'braces', type: 'json' },
  jsonc: { shape: 'braces', type: 'json' },
  yaml: { shape: 'config', type: 'config' },
  yml: { shape: 'config', type: 'config' },
  toml: { shape: 'config', type: 'config' },
  ini: { shape: 'config', type: 'config' },
  conf: { shape: 'config', type: 'config' },
  env: { shape: 'config', type: 'config' },
  md: { shape: 'text', type: 'markdown' },
  mdx: { shape: 'text', type: 'markdown' },
  txt: { shape: 'text', type: 'text' },
  log: { shape: 'text', type: 'text' },
  csv: { shape: 'text', type: 'text' },
  sh: { shape: 'terminal', type: 'shell' },
  bash: { shape: 'terminal', type: 'shell' },
  zsh: { shape: 'terminal', type: 'shell' },
  fish: { shape: 'terminal', type: 'shell' },
  sql: { shape: 'database', type: 'sql' },
  png: { shape: 'image', type: 'image' },
  jpg: { shape: 'image', type: 'image' },
  jpeg: { shape: 'image', type: 'image' },
  gif: { shape: 'image', type: 'image' },
  webp: { shape: 'image', type: 'image' },
  ico: { shape: 'image', type: 'image' },
  icns: { shape: 'image', type: 'image' },
  mp3: { shape: 'media', type: 'media' },
  wav: { shape: 'media', type: 'media' },
  mp4: { shape: 'media', type: 'media' },
  mov: { shape: 'media', type: 'media' },
  zip: { shape: 'archive', type: 'archive' },
  gz: { shape: 'archive', type: 'archive' },
  tgz: { shape: 'archive', type: 'archive' },
  tar: { shape: 'archive', type: 'archive' },
  lock: { shape: 'lock', type: 'lock' },
};

const plain: FileIconKind = { shape: 'plain', type: 'plain' };

export function fileIconKind(path: string): FileIconKind {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const named = byName[name] ?? (name.startsWith('dockerfile') ? byName.dockerfile : undefined);
  if (named) return named;
  if (name.startsWith('.env.')) return byName['.env'];
  const dot = name.lastIndexOf('.');
  return (dot > 0 && byExtension[name.slice(dot + 1)]) || plain;
}
