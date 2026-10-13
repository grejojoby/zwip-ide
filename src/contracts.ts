/** Shared v1 transport contracts. Positions and edit offsets use UTF-16. */
export interface Position {
  line: number;
  character: number;
}
export interface SourceRange {
  start: Position;
  end: Position;
}
export interface FileEntry {
  path: string;
  relativePath: string;
  size: number;
}
export interface BuildContext {
  id: string;
  root: string;
  language: string;
  configPath: string;
  documentExtensions?: string[];
  profileId?: string;
  settings?: Record<string, unknown>;
  state: 'ready' | 'loading' | 'failed' | 'unavailable';
  reason?: string;
}
export interface ExcludedDirectory {
  /** Workspace-relative directory path. */
  path: string;
  reason: string;
}
export interface WorkspaceSnapshot {
  root: string;
  name: string;
  generation: number;
  files: FileEntry[];
  directories?: string[];
  contexts: BuildContext[];
  excluded: string[];
  excludedDirectories?: ExcludedDirectory[];
}
export interface DocumentSnapshot {
  path: string;
  content: string;
  revision: number;
  workspaceGeneration: number;
  dirty: boolean;
}
export type DocumentAck = Omit<DocumentSnapshot, 'content'>;
export interface RecoveryEntry {
  path: string;
  revision: number;
  bytes: number;
  preview: string;
  missing: boolean;
  open: boolean;
}
export interface TextDelta {
  from: number;
  to: number;
  insert: string;
}
export type NavigationOperation =
  | 'definition'
  | 'typeDefinition'
  | 'references'
  | 'implementations'
  | 'typeHierarchy'
  | 'incomingCalls'
  | 'outgoingCalls';
export type QueryState = 'loading' | 'complete' | 'partial' | 'canceled' | 'unsupported' | 'failed';
export interface NavigationQuery {
  id: string;
  operation: NavigationOperation;
  path: string;
  position: Position;
  documentRevision: number;
  workspaceGeneration: number;
  contextIds?: string[];
  sourceContextId?: string;
}
export interface SourceLocation {
  path: string;
  range: SourceRange;
  name: string;
  preview: string;
  contextIds: string[];
  relationship: string;
}
export interface NavigationBatch {
  id: string;
  documentRevision: number;
  workspaceGeneration: number;
  state: QueryState;
  locations: SourceLocation[];
  searchedContexts: number;
  totalContexts: number;
  reasons: string[];
}
export type EditorOperation =
  'completion' | 'hover' | 'diagnostics' | 'format' | 'rename' | 'symbols' | 'codeActions';
export interface EditorRequest {
  id: string;
  operation: EditorOperation;
  path: string;
  position?: Position;
  range?: SourceRange;
  documentRevision: number;
  workspaceGeneration: number;
  newName?: string;
  query?: string;
  sourceContextId?: string;
}
export interface SemanticEdit {
  path: string;
  revision?: number;
  fileHash?: string;
  range: SourceRange;
  newText: string;
}
export interface SemanticCompletion {
  label: string;
  detail?: string;
  insertText: string;
  range?: SourceRange;
  additionalEdits?: SemanticEdit[];
}
export interface SemanticDiagnostic {
  range: SourceRange;
  severity: 'error' | 'warning' | 'information';
  message: string;
  source?: string;
}
export interface EditorResult {
  id: string;
  documentRevision: number;
  workspaceGeneration: number;
  state: QueryState;
  reasons: string[];
  completions?: SemanticCompletion[];
  diagnostics?: SemanticDiagnostic[];
  edits?: SemanticEdit[];
  hover?: string;
  symbols?: SourceLocation[];
  codeActions?: { title: string; kind?: string; edits: SemanticEdit[] }[];
}
export interface WorkspaceEditFile {
  path: string;
  before: string;
  after: string;
  revision: number;
  fileHash: string;
}
export interface WorkspaceEditPreview {
  id: string;
  workspaceGeneration: number;
  files: WorkspaceEditFile[];
}
export interface PackageState {
  id: string;
  name: string;
  description: string;
  version: string;
  installed: boolean;
  enabled: boolean;
  running: boolean;
  capabilities: string[];
  error?: string;
}
/** A catalog package being downloaded or installed. */
export type PackageInstallProgress =
  { phase: 'downloading'; received: number; total: number | null } | { phase: 'installing' };
export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}
export interface GitFile {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  originalPath?: string;
}
export interface GitSnapshot {
  root: string;
  branch: string;
  head: string;
  fingerprint: string;
  files: GitFile[];
}
export interface DiffLine {
  id: string;
  kind: 'context' | 'add' | 'remove';
  text: string;
  oldLine?: number;
  newLine?: number;
}
export interface DiffHunk {
  id: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}
export interface GitDiff {
  path: string;
  before: string;
  after: string;
  patch: string;
  binary: boolean;
  fingerprint: string;
  kind: 'text' | 'binary' | 'symlink' | 'submodule' | 'rename';
  partialAllowed: boolean;
  hunks: DiffHunk[];
}
export interface CommitSelection {
  path: string;
  changeIds?: string[];
}
export interface ChangelistSelection {
  path: string;
  changeIds: string[];
  fingerprint: string;
  stale?: boolean;
}
export interface Changelist {
  id: string;
  name: string;
  paths: string[];
  selections?: ChangelistSelection[];
}
export interface MergeSession {
  path: string;
  fingerprint: string;
  kind: 'text' | 'binary' | 'symlink' | 'submodule';
  conflictType: 'content' | 'addAdd' | 'modifyDelete' | 'deleteDelete';
  base: string | null;
  ours: string | null;
  theirs: string | null;
  result: string | null;
  labels: { base: string; ours: string; theirs: string };
  operation: 'merge' | 'rebase' | 'cherryPick' | 'revert' | 'unknown';
}
export interface PushCommit {
  id: string;
  subject: string;
  author: string;
}
export interface PushPlan {
  fingerprint: string;
  remote: string;
  branch: string;
  upstream: string;
  commits: PushCommit[];
  files: string[];
  diff: string;
}
export interface HistoryEntry {
  id: number;
  path: string;
  timestamp: number;
  content: string;
}
export interface TaskResult {
  id: string;
  output: string;
  exitCode: number | null;
  running: boolean;
}

export interface Connection {
  id: string;
  kind: 'mysql' | 'postgres' | 'sqlite' | 'redis';
  name: string;
  config: {
    host?: string;
    port?: number;
    database?: string;
    username?: string;
    path?: string;
    tls?: boolean;
  };
}
export interface SqlColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
}
export interface SqlTable {
  schema: string;
  name: string;
  type: 'table' | 'view';
}
export interface SqlPage {
  rows: Record<string, unknown>[];
  columns: SqlColumn[];
  primaryKey: string[];
  editable: boolean;
  hasMore: boolean;
  offset: number;
  truncated: boolean;
}
export interface SqlQueryPage {
  queryId?: string;
  rows: Record<string, unknown>[];
  columns: string[];
  done: boolean;
  affectedRows?: number;
  truncated: boolean;
}
export interface HttpResponse {
  id: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  encoding: 'text' | 'base64';
  bytes: number;
  truncated: boolean;
  durationMs: number;
  url: string;
}

export interface PackageCatalog {
  url: string;
  packages: {
    id: string;
    name: string;
    version: string;
    url: string;
    sha256: string;
    platform: string;
    architecture: string;
    dependencies: Record<string, string>;
  }[];
}
