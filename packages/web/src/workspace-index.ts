import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type {
  EditorResult,
  BuildContext,
  NavigationOperation,
  SourceLocation,
} from '../../../src/contracts';

export type IndexValue = { locations: SourceLocation[]; error?: string };
export type IndexToken = {
  start: number;
  end: number;
  operations: Partial<Record<NavigationOperation, string>>;
};
export type CachedEditorResult = Pick<
  EditorResult,
  'state' | 'reasons' | 'diagnostics' | 'symbols'
>;
export type IndexFile = {
  editor?: Partial<Record<'diagnostics' | 'symbols', CachedEditorResult>>;
  length: number;
  lines: number[];
  tokens: IndexToken[];
};
export type ProjectIndex = {
  id: string;
  files: Record<string, IndexFile>;
  reasons: string[];
  metadata: {
    sdkVersion: string;
    sdkPath: string;
    sdkSource: 'workspace' | 'fallback';
    diagnostics: string[];
    plugins: import('./next-plugin').PluginStatus[];
  };
};
export type WorkspaceIndex = {
  schema: 1;
  root: string;
  identity: string;
  complete: boolean;
  files: Record<string, string>;
  directories: Record<string, string>;
  projects: ProjectIndex[];
  values: Record<string, IndexValue>;
};
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function fileHash(path: string): string {
  try {
    if (statSync(path).isDirectory()) return `directory:${directoryHash(path)}`;
    return hash(readFileSync(path));
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT' ||
      (error as NodeJS.ErrnoException).code === 'ENOTDIR'
    )
      return 'missing';
    throw error;
  }
}
export function directoryHash(path: string): string {
  return hash(
    JSON.stringify(
      readdirSync(path, { withFileTypes: true })
        .map((entry) => [
          entry.name,
          entry.isDirectory(),
          entry.isSymbolicLink() ? realpathSync(join(path, entry.name)) : null,
        ])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ),
  );
}
export function directoryInputs(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (path: string) => {
    result[path] = directoryHash(path);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        !['.git', 'node_modules', 'target', 'dist', '.next', '.cache'].includes(entry.name)
      )
        visit(join(path, entry.name));
    }
  };
  visit(root);
  return result;
}
export function indexCurrent(index: WorkspaceIndex): boolean {
  return (
    Object.entries(index.files).every(
      ([path, expected]) => isAbsolute(path) && fileHash(path) === expected,
    ) &&
    Object.entries(index.directories).every(
      ([path, expected]) => isAbsolute(path) && directoryHash(path) === expected,
    )
  );
}
function wellFormed(index: WorkspaceIndex): boolean {
  if (
    index.schema !== 1 ||
    !Array.isArray(index.projects) ||
    !index.values ||
    !index.files ||
    !index.directories
  )
    return false;
  if (new Set(index.projects.map((project) => project.id)).size !== index.projects.length)
    return false;
  for (const [key, value] of Object.entries(index.values)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !Array.isArray(value.locations)) return false;
    for (const location of value.locations) {
      if (
        !isAbsolute(location.path) ||
        !Array.isArray(location.contextIds) ||
        typeof location.relationship !== 'string' ||
        !location.range ||
        !Number.isSafeInteger(location.range.start.line) ||
        !Number.isSafeInteger(location.range.end.line) ||
        !Number.isSafeInteger(location.range.start.character) ||
        !Number.isSafeInteger(location.range.end.character)
      )
        return false;
    }
  }
  for (const project of index.projects) {
    if (!project.metadata || !Array.isArray(project.reasons) || !project.files) return false;
    for (const [path, file] of Object.entries(project.files)) {
      if (
        !isAbsolute(path) ||
        !Number.isSafeInteger(file.length) ||
        !Array.isArray(file.lines) ||
        !Array.isArray(file.tokens)
      )
        return false;
      if (
        file.lines[0] !== 0 ||
        file.lines.some(
          (line, i) =>
            !Number.isSafeInteger(line) ||
            line < 0 ||
            line > file.length ||
            (i > 0 && line <= file.lines[i - 1]),
        )
      )
        return false;
      for (const token of file.tokens) {
        if (
          !Number.isSafeInteger(token.start) ||
          !Number.isSafeInteger(token.end) ||
          token.start < 0 ||
          token.end < token.start ||
          token.end > file.length ||
          !token.operations ||
          Object.values(token.operations).some(
            (key) => typeof key !== 'string' || !index.values[key],
          )
        )
          return false;
      }
    }
  }
  return true;
}

/** Versioned provider-owned semantic checkpoint. It contains a materialized index
 * for every source token, not a cache of queries the user happened to request. */
export class WebIndexStore {
  constructor(private readonly directory: string | undefined) {}
  identity(
    root: string,
    contexts: BuildContext[],
    epoch: string,
    provider: string,
    enabled: string[],
  ): string {
    return hash(
      JSON.stringify([
        1,
        root,
        contexts.map(({ id, root, configPath, profileId, settings }) => ({
          id,
          root,
          configPath,
          profileId,
          settings,
        })),
        epoch,
        provider,
        [...enabled].sort(),
      ]),
    );
  }
  private filename(root: string, partial = false): string {
    if (!this.directory || !isAbsolute(this.directory))
      throw new Error('Persistent web index storage is unavailable.');
    return join(
      this.directory,
      'workspace-index',
      hash(root),
      partial ? 'partial.json' : 'index.json',
    );
  }
  load(root: string, identity: string): WorkspaceIndex | null {
    for (const partial of [false, true]) {
      try {
        const path = this.filename(root, partial);
        if (statSync(path).size > 128 * 1024 * 1024) continue;
        const envelope = JSON.parse(readFileSync(path, 'utf8')) as {
          digest: string;
          data: WorkspaceIndex;
        };
        const data = envelope.data;
        if (
          data?.root === root &&
          data.identity === identity &&
          envelope.digest === hash(JSON.stringify(data)) &&
          wellFormed(data) &&
          indexCurrent(data)
        )
          return data;
      } catch {
        /* Corrupt, incomplete or incompatible snapshots fall back to indexing. */
      }
    }
    return null;
  }
  save(index: WorkspaceIndex): void {
    if (!wellFormed(index) || !indexCurrent(index))
      throw new Error('Workspace changed while its semantic index was being built.');
    const path = this.filename(index.root, !index.complete);
    const body = JSON.stringify(index);
    if (Buffer.byteLength(body) > 128 * 1024 * 1024)
      throw new Error('Web workspace index exceeds the 128 MiB checkpoint limit.');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ digest: hash(body), data: index }), {
        mode: 0o600,
        flag: 'wx',
      });
      const file = openSync(temporary, 'r');
      try {
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      renameSync(temporary, path);
    } finally {
      try {
        unlinkSync(temporary);
      } catch (error) {
        // Cleanup failure must not mask the publication result.
        void error;
      }
    }
  }
}
