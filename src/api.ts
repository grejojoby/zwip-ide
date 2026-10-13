import { invoke } from '@tauri-apps/api/core';
import type {
  Changelist,
  ChangelistSelection,
  CommitSelection,
  MergeSession,
  EditorRequest,
  EditorResult,
  SemanticEdit,
  WorkspaceEditPreview,
} from './contracts';
import type {
  WorkspaceSnapshot,
  DocumentSnapshot,
  DocumentAck,
  TextDelta,
  NavigationQuery,
  NavigationBatch,
  PackageState,
  SearchMatch,
  GitSnapshot,
  GitDiff,
  PushPlan,
  HistoryEntry,
  TaskResult,
} from './contracts';

export function request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return invoke<T>('ide_request', { method, params }).then((result) => {
    if (
      ['package.install', 'package.enable', 'package.installCatalog', 'package.rollback'].includes(
        method,
      )
    )
      window.dispatchEvent(new Event('zwip:packages-changed'));
    return result;
  });
}
export const api = {
  /** `revealEnvironment` includes credential-like run environment values the user confirmed. */
  previewIntelliJ: (path: string, projectRoot?: string, revealEnvironment = false) =>
    request<import('./model/intellij-import-contracts').IntelliJImportPreview>('intellij.preview', {
      path,
      projectRoot,
      ...(revealEnvironment && { revealEnvironment }),
    }),
  importIntelliJConnections: (
    path: string,
    fingerprint: string,
    ids: string[],
    projectRoot?: string,
  ) =>
    request<import('./model/intellij-import-contracts').IntelliJConnectionImportResult>(
      'intellij.importConnections',
      { path, projectRoot, fingerprint, ids },
    ).then((result) => {
      window.dispatchEvent(new Event('zwip:connections-changed'));
      return result;
    }),
  toolRequest: <T>(
    packageId: string,
    method: string,
    params: Record<string, unknown> = {},
    synchronizeDocuments = false,
  ) => request<T>('tool.request', { packageId, method, params, synchronizeDocuments }),
  connections: () => request<import('./contracts').Connection[]>('connection.list'),
  saveConnection: (connection: import('./contracts').Connection, password?: string) =>
    request<import('./contracts').Connection[]>('connection.save', { ...connection, password }),
  deleteConnection: (id: string) =>
    request<import('./contracts').Connection[]>('connection.delete', { id }),
  getSetting: <T>(key: string) => request<T | null>('settings.get', { key }),
  setSetting: <T>(key: string, value: T) => request<T>('settings.set', { key, value }),
  openWorkspace: (root: string) => request<WorkspaceSnapshot>('workspace.open', { root }),
  refreshWorkspace: () => request<WorkspaceSnapshot>('workspace.refresh'),
  rescanWorkspace: (reanalyze: boolean) =>
    request<WorkspaceSnapshot>('workspace.rescan', { reanalyze }),
  setDirectoryExcluded: (path: string, excluded: boolean) =>
    request<WorkspaceSnapshot>('workspace.setExcluded', { path, excluded }),
  workspaceChanges: () =>
    request<{ paths: string[]; configurationChanged: boolean }>('workspace.changes'),
  scanProgress: () => request<{ files: number }>('workspace.scanProgress'),
  workspaceStatus: () =>
    request<{ generation: number; contexts: import('./contracts').BuildContext[] }>(
      'workspace.status',
    ),
  syncDocument: (path: string) =>
    request<{
      document: DocumentSnapshot;
      changed: boolean;
      conflict: boolean;
      rollbackRevision?: number;
    }>('document.sync', { path }),
  rejectDocumentSync: (path: string, revision: number) =>
    request<DocumentSnapshot>('document.rejectSync', { path, revision }),
  openDocument: (path: string) => request<DocumentSnapshot>('document.open', { path }),
  closeDocument: (path: string, revision: number) =>
    request<{ released: boolean }>('document.close', { path, revision }),
  recovery: () => request<import('./contracts').RecoveryEntry[]>('recovery.list'),
  restoreRecoveryCopy: (path: string, revision: number, destination: string) =>
    request<{ path: string }>('recovery.restoreCopy', { path, revision, destination }),
  discardRecovery: (path: string, revision: number) =>
    request<void>('recovery.discard', { path, revision }),
  changeDocument: (path: string, revision: number, changes: TextDelta[]) =>
    request<DocumentAck>('document.change', { path, revision, changes }),
  saveDocument: (path: string, revision: number) =>
    request<DocumentSnapshot>('document.save', { path, revision }),
  history: (path: string) => request<HistoryEntry[]>('document.history', { path }),
  search: (query: string) => request<SearchMatch[]>('workspace.search', { query }),
  navigate: (query: NavigationQuery) => request<NavigationBatch>('navigation.query', { query }),
  navigationProgress: (id: string) =>
    request<NavigationBatch | null>('navigation.progress', { id }),
  workspaceSymbols: (id: string, query: string, workspaceGeneration: number) =>
    request<NavigationBatch>('workspace.symbols', { id, query, workspaceGeneration }),
  editorRequest: (query: EditorRequest) => request<EditorResult>('editor.request', { query }),
  previewEdit: (edits: SemanticEdit[], workspaceGeneration: number) =>
    request<WorkspaceEditPreview>('workspace.editPreview', { edits, workspaceGeneration }),
  applyEdit: (id: string) => request<DocumentSnapshot[]>('workspace.editApply', { id }),
  cancelNavigation: (id: string) => request<void>('navigation.cancel', { id }),
  packages: () => request<PackageState[]>('package.list'),
  configureCatalog: (url: string) => request<{ url: string }>('package.catalogConfigure', { url }),
  packageCatalog: () => request<import('./contracts').PackageCatalog>('package.catalog'),
  installCatalogPackage: (id: string, version: string) =>
    request<PackageState[]>('package.installCatalog', { id, version }),
  restartPackage: (id: string) => request<PackageState[]>('package.restart', { id }),
  rollbackPackage: (id: string) => request<PackageState[]>('package.rollback', { id }),
  enablePackage: (id: string, enabled: boolean) =>
    request<PackageState[]>('package.enable', { id, enabled }),
  packageInstallProgress: () =>
    request<Record<string, import('./contracts').PackageInstallProgress>>(
      'package.installProgress',
    ),
  installPackage: (path: string) => request<PackageState[]>('package.install', { path }),
  gitStatus: () => request<GitSnapshot>('git.status'),
  gitDiff: (path: string) => request<GitDiff>('git.diff', { path }),
  gitCommit: (paths: string[], message: string, fingerprint: string) =>
    request<GitSnapshot>('git.commit', { paths, message, fingerprint }),
  gitCommitSelection: (selections: CommitSelection[], message: string, fingerprint: string) =>
    request<GitSnapshot>('git.commitSelection', { selections, message, fingerprint }),
  changelists: () => request<Changelist[]>('git.changelists'),
  saveChangelist: (id: string, name: string, paths: string[], selections?: ChangelistSelection[]) =>
    request<Changelist[]>('git.saveChangelist', { id, name, paths, selections }),
  deleteChangelist: (id: string) => request<Changelist[]>('git.deleteChangelist', { id }),
  gitConflicts: () => request<string[]>('git.conflicts'),
  mergeOpen: (path: string) => request<MergeSession>('git.mergeOpen', { path }),
  mergeApply: (
    path: string,
    fingerprint: string,
    resolution: 'result' | 'ours' | 'theirs' | 'delete',
    result?: string,
  ) => request<GitSnapshot>('git.mergeApply', { path, fingerprint, resolution, result }),
  pushPlan: () => request<PushPlan>('git.pushPlan'),
  push: (fingerprint: string) => request<string>('git.push', { fingerprint }),
  startTerminal: (rows: number, cols: number) =>
    request<{ id: string }>('terminal.start', { rows, cols }),
  readTerminal: (id: string, cursor: number) =>
    request<{
      bytes: number[];
      cursor: number;
      dropped: boolean;
      running: boolean;
      exitCode?: number;
    }>('terminal.read', { id, cursor }),
  writeTerminal: (id: string, bytes: number[]) => request<void>('terminal.write', { id, bytes }),
  resizeTerminal: (id: string, rows: number, cols: number) =>
    request<void>('terminal.resize', { id, rows, cols }),
  stopTerminal: (id: string) => request<void>('terminal.stop', { id }),
  runTask: (command: string, cwd?: string, env?: { name: string; value: string }[]) =>
    request<TaskResult>('task.start', { command, cwd, ...(env && { env }) }),
  taskStatus: (id: string) => request<TaskResult>('task.status', { id }),
  stopTask: (id: string) => request<void>('task.stop', { id }),
};
