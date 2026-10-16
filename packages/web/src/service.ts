import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { sep, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import type * as ts from 'typescript-sdk';
import type {
  BuildContext,
  EditorRequest,
  EditorResult,
  NavigationBatch,
  NavigationOperation,
  NavigationQuery,
  Position,
  SemanticEdit,
  SourceLocation,
} from '../../../src/contracts';
import { isMarkup, markupEditor, markupNavigation } from './markup';
import { loadNextPlugin, type PluginStatus } from './next-plugin';
import {
  WebIndexStore,
  directoryInputs,
  directoryHash,
  fileHash,
  hash,
  indexCurrent,
  type WorkspaceIndex,
  type ProjectIndex,
  type IndexToken,
  type IndexValue,
} from './workspace-index';

type TypeScript = typeof ts;
type Overlay = { content: string; revision: number };
type Anchor = { path: string; offset: number };
type Project = {
  context: BuildContext;
  sdk: TypeScript;
  sdkPath: string;
  sdkSource: 'workspace' | 'fallback';
  service: ts.LanguageService;
  diagnostics: string[];
  checkedVersion: number;
  coverageReasons: string[];
  plugins: PluginStatus[];
  inputFiles: Record<string, string>;
  inputDirectories: Record<string, string>;
  readonly indexError?: string;
};

export interface InitializeParams {
  root: string;
  contexts: BuildContext[];
  generation: number;
  enabledPackages?: string[];
  workspaceIndex?: { epoch?: string | null; rebuild?: boolean };
}
export interface DocumentUpdate {
  path: string;
  content: string;
  revision: number;
}
export interface WorkspaceSymbolsRequest {
  id: string;
  query: string;
  workspaceGeneration: number;
}
export const capabilities: NavigationOperation[] = [
  'definition',
  'typeDefinition',
  'references',
  'implementations',
  'typeHierarchy',
  'incomingCalls',
  'outgoingCalls',
];
const require = createRequire(import.meta.url);

function canonical(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

function compatible(sdk: TypeScript): boolean {
  const [major, minor] = sdk.versionMajorMinor?.split('.').map(Number) ?? [];
  return (
    (major > 4 || (major === 4 && minor >= 7)) && typeof sdk.createLanguageService === 'function'
  );
}

function loadSdk(root: string): {
  sdk: TypeScript;
  path: string;
  source: 'workspace' | 'fallback';
  diagnostics: string[];
} {
  const diagnostics: string[] = [];
  let workspacePath: string | undefined;
  try {
    workspacePath = createRequire(resolve(root, 'package.json')).resolve('typescript');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
    diagnostics.push(
      `No workspace TypeScript SDK found in ${root}; using the packaged fallback SDK.`,
    );
  }
  if (workspacePath) {
    const sdk = require(workspacePath) as TypeScript;
    if (compatible(sdk)) return { sdk, path: workspacePath, source: 'workspace', diagnostics };
    diagnostics.push(
      `Workspace TypeScript ${sdk.version ?? 'unknown'} is incompatible with provider v1 (requires 4.7+); using the packaged fallback SDK.`,
    );
  }
  const packaged = fileURLToPath(
    new URL('./fallback-sdk/typescript/lib/typescript.js', import.meta.url),
  );
  const path = existsSync(packaged) ? packaged : require.resolve('typescript-sdk');
  const sdk = require(path) as TypeScript;
  if (!compatible(sdk))
    throw new Error(`Fallback TypeScript ${sdk.version ?? 'unknown'} is incompatible.`);
  return { sdk, path, source: 'fallback', diagnostics };
}

/** One language service per configured project; all projects are loaded before queries. */
export class WebSemanticService {
  private root = '';
  private generation = -1;
  private version = 0;
  private contexts: BuildContext[] = [];
  private projects = new Map<string, Project>();
  private failures = new Map<string, string>();
  private overlays = new Map<string, Overlay>();
  private enabledPackages = new Set<string>();
  private readonly indexStore: WebIndexStore;
  private readonly persistentIndex: boolean;
  private checkpoint: WorkspaceIndex | null = null;
  private checkpointIdentity = '';
  private indexTask: Promise<void> | undefined;
  private indexEager = false;
  private lifecycle = 0;
  private pendingIndex = false;
  private indexProgress = new Map<
    string,
    Pick<BuildContext, 'indexState' | 'indexReason' | 'indexed' | 'packages' | 'indexUnits'>
  >();
  constructor(cacheDirectory = process.env.ZWIP_PACKAGE_CACHE) {
    this.indexStore = new WebIndexStore(cacheDirectory);
    this.persistentIndex = Boolean(cacheDirectory && isAbsolute(cacheDirectory));
  }
  private ensureProjects() {
    for (const context of this.contexts) {
      if (this.projects.has(context.id) || this.failures.has(context.id)) continue;
      try {
        this.projects.set(context.id, this.createProject(context));
      } catch (error) {
        this.failures.set(context.id, this.errorText(error));
      }
    }
  }
  private checkpointUsable(): boolean {
    const index = this.checkpoint;
    if (!index) return false;
    for (const [path, overlay] of this.overlays) {
      if (index.files[path] !== hash(overlay.content)) return false;
    }
    try {
      if (indexCurrent(index)) return true;
    } catch {
      /* Rebuild from live files. */
    }
    this.workspaceChanged([]);
    return false;
  }

  initialize(params: InitializeParams) {
    if (
      !isAbsolute(params.root) ||
      !Number.isSafeInteger(params.generation) ||
      !Array.isArray(params.contexts)
    )
      throw new Error('Invalid workspace initialization.');
    this.dispose();
    this.root = canonical(params.root);
    this.generation = params.generation;
    this.enabledPackages = new Set(params.enabledPackages ?? []);
    this.contexts = params.contexts
      .filter((context) =>
        ['web', 'typescript', 'javascript', 'tsx', 'jsx'].includes(context.language),
      )
      .map((context) => ({
        ...context,
        root: canonical(context.root),
        configPath: canonical(context.configPath),
      }));
    this.checkpointIdentity = this.indexStore.identity(
      this.root,
      this.contexts,
      params.workspaceIndex?.epoch ?? 'initial',
      hash(readFileSync(fileURLToPath(import.meta.url))),
      [...this.enabledPackages],
    );
    if (this.persistentIndex && !params.workspaceIndex?.rebuild)
      this.checkpoint = this.indexStore.load(this.root, this.checkpointIdentity);
    const seen = new Set<string>();
    for (const context of this.contexts) {
      if (seen.has(context.id)) throw new Error(`Duplicate context ID: ${context.id}`);
      seen.add(context.id);
      try {
        if (context.profileId || Object.keys(context.settings ?? {}).length)
          throw new Error(
            'Web build profiles must use separate tsconfig/jsconfig files; custom profile settings are unsupported.',
          );
        const cached = this.checkpoint?.projects.find((item) => item.id === context.id);
        if (cached) {
          const count = Object.keys(cached.files).filter(
            (path) => inside(this.root, path) && !path.includes('/node_modules/'),
          ).length;
          this.indexProgress.set(context.id, {
            indexState: 'restored',
            indexReason: cached.reasons.join('; ') || undefined,
            indexed: count,
            packages: count,
            indexUnits: 'files',
          });
        } else this.projects.set(context.id, this.createProject(context));
      } catch (error) {
        this.failures.set(context.id, this.errorText(error));
      }
    }
    return {
      capabilities: [
        ...capabilities,
        'completion',
        'hover',
        'diagnostics',
        'format',
        'rename',
        'symbols',
        'workspaceSymbols',
        'codeActions',
      ],
      indexCapabilities: ['workspaceCheckpoint', 'workspaceRestore'],
      ...this.workspaceStatus(),
    };
  }

  workspaceStatus() {
    return {
      generation: this.generation,
      contexts: this.contexts.map((context) => {
        const project = this.projects.get(context.id);
        const cached = this.checkpoint?.projects.find((item) => item.id === context.id);
        return {
          ...context,
          state: !this.failures.has(context.id) && (project || cached) ? 'ready' : 'failed',
          compilerHydrated: Boolean(project),
          ...this.indexProgress.get(context.id),
          reason: this.failures.get(context.id),
          sdkVersion: project?.sdk.version ?? cached?.metadata.sdkVersion,
          sdkPath: project?.sdkPath ?? cached?.metadata.sdkPath,
          sdkSource: project?.sdkSource ?? cached?.metadata.sdkSource,
          diagnostics: project?.diagnostics ?? cached?.metadata.diagnostics ?? [],
          plugins: project?.plugins ?? cached?.metadata.plugins ?? [],
        };
      }),
    };
  }

  updateDocument(update: DocumentUpdate) {
    if (
      typeof update.content !== 'string' ||
      !Number.isSafeInteger(update.revision) ||
      update.revision < 0 ||
      !isAbsolute(update.path)
    )
      throw new Error('Invalid document update.');
    const path = canonical(update.path);
    if (!inside(this.root, path)) throw new Error('Document is outside this workspace.');
    const previous = this.overlays.get(path);
    if (
      previous &&
      (update.revision < previous.revision ||
        (update.revision === previous.revision && update.content !== previous.content))
    )
      throw new Error('Document revision is obsolete or conflicts with existing content.');
    this.overlays.set(path, { content: update.content, revision: update.revision });
    this.version++;
    if (this.indexTask) this.pendingIndex = true;
    return { path, revision: update.revision, workspaceGeneration: this.generation };
  }

  workspaceChanged(paths: string[]) {
    if (
      !Array.isArray(paths) ||
      paths.some(
        (path) =>
          typeof path !== 'string' || !isAbsolute(path) || !inside(this.root, canonical(path)),
      )
    )
      throw new Error('Changed files must be absolute workspace paths.');
    this.checkpoint = null;
    for (const context of this.contexts)
      this.indexProgress.set(context.id, { indexState: 'invalidated' });
    // Reparse file lists as well as snapshots: a new unopened file can introduce references.
    // Existing overlays are kept because their unsaved contents take precedence over disk.
    for (const project of this.projects.values()) project.service.dispose();
    this.projects.clear();
    this.failures.clear();
    this.version++;
    for (const context of this.contexts) {
      try {
        this.projects.set(context.id, this.createProject(context));
      } catch (error) {
        this.failures.set(context.id, this.errorText(error));
      }
    }
    if (this.indexEager) this.indexWorkspace();
    return { workspaceGeneration: this.generation, paths };
  }

  closeDocument(path: string) {
    if (!isAbsolute(path) || !inside(this.root, canonical(path)))
      throw new Error('Closed document must be an absolute workspace path.');
    const key = canonical(path);
    if (this.overlays.delete(key)) this.version++;
    return { path: key, revision: 0, workspaceGeneration: this.generation };
  }

  async editor(
    request: EditorRequest,
    canceled: () => boolean = () => false,
  ): Promise<EditorResult> {
    const result: EditorResult = {
      id: request.id,
      documentRevision: request.documentRevision,
      workspaceGeneration: request.workspaceGeneration,
      state: 'complete',
      reasons: [],
    };
    try {
      if (request.workspaceGeneration !== this.generation)
        throw new Error('Workspace generation is obsolete.');
      if (!isAbsolute(request.path) || !inside(this.root, canonical(request.path)))
        throw new Error('Editor path must be inside this workspace.');
      const path = canonical(request.path);
      if ((this.overlays.get(path)?.revision ?? 0) !== request.documentRevision)
        throw new Error('Document revision does not match the provider overlay.');
      if (isMarkup(path))
        return markupEditor(
          { ...request, path },
          this.overlays.get(path)?.content ?? readFileSync(path, 'utf8'),
          this.contexts
            .filter((context) => inside(context.root, path))
            .map((context) => context.id),
        );
      if (!/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(path))
        return {
          ...result,
          state: 'unsupported',
          reasons: ['Semantic editor features for this language are not available.'],
        };
      if (
        (request.operation === 'diagnostics' ||
          (request.operation === 'symbols' && !request.query)) &&
        this.checkpointUsable()
      ) {
        const cached = this.checkpoint!.projects.filter((project) => project.files[path]).sort(
          (a, b) => {
            const left = this.contexts.find((context) => context.id === a.id)!;
            const right = this.contexts.find((context) => context.id === b.id)!;
            return (
              Number(inside(right.root, path)) - Number(inside(left.root, path)) ||
              right.root.length - left.root.length
            );
          },
        )[0]?.files[path].editor?.[request.operation as 'diagnostics' | 'symbols'];
        if (cached) {
          await yieldTurn();
          if (canceled()) return { ...result, state: 'canceled' };
          return {
            ...structuredClone(cached),
            id: request.id,
            documentRevision: request.documentRevision,
            workspaceGeneration: this.generation,
          };
        }
      }
      this.ensureProjects();
      const projects = [...this.projects.values()]
        .filter((project) => this.sourceFile(project, path))
        .sort(
          (a, b) =>
            Number(inside(b.context.root, path)) - Number(inside(a.context.root, path)) ||
            b.context.root.length - a.context.root.length,
        );
      const project = projects[0];
      if (!project) throw new Error('The file is not included in a loaded web project.');
      const { service, sdk } = project;
      const pluginProblems = project.plugins.flatMap((plugin) =>
        plugin.reason ? [plugin.reason] : [],
      );
      if (pluginProblems.length) {
        result.state = 'partial';
        result.reasons.push(...pluginProblems);
      }
      const offset = request.position ? this.offset(project, path, request.position) : 0;
      const format: ts.FormatCodeSettings = {
        tabSize: 2,
        indentSize: 2,
        convertTabsToSpaces: true,
        newLineCharacter: '\n',
        semicolons: sdk.SemicolonPreference.Ignore,
      };
      const preferences: ts.UserPreferences = {
        includeCompletionsForModuleExports: true,
        includeCompletionsWithInsertText: true,
        includeCompletionsWithSnippetText: false,
        providePrefixAndSuffixTextForRename: true,
      };
      await yieldTurn();
      if (canceled()) return { ...result, state: 'canceled', reasons: ['Request canceled.'] };
      switch (request.operation) {
        case 'completion': {
          const completion = service.getCompletionsAtPosition(path, offset, preferences);
          result.completions = [];
          const entries = completion?.entries ?? [];
          if (entries.length > 512) {
            result.state = 'partial';
            result.reasons.push(
              'Completion list is limited to 512 entries; type a narrower prefix.',
            );
          }
          for (const entry of entries.slice(0, 512)) {
            if (entry.isSnippet) continue;
            const details = entry.source
              ? service.getCompletionEntryDetails(
                  path,
                  offset,
                  entry.name,
                  format,
                  entry.source,
                  preferences,
                  entry.data,
                )
              : undefined;
            // Commands cannot be represented by a reviewed text edit. Omit those candidates.
            if (details?.codeActions?.some((action) => action.commands?.length)) continue;
            const additionalEdits = details?.codeActions?.flatMap((action) =>
              this.fileEdits(project, action.changes),
            );
            result.completions.push({
              label: entry.name,
              detail: details ? sdk.displayPartsToString(details.displayParts) : entry.kind,
              insertText: entry.insertText ?? entry.name,
              range: entry.replacementSpan
                ? this.location(project, path, entry.replacementSpan, '', '').range
                : undefined,
              additionalEdits,
            });
          }
          break;
        }
        case 'hover': {
          const info = service.getQuickInfoAtPosition(path, offset);
          result.hover = info
            ? [
                sdk.displayPartsToString(info.displayParts),
                sdk.displayPartsToString(info.documentation),
                ...(info.tags ?? []).map(
                  (tag) =>
                    `@${tag.name} ${typeof tag.text === 'string' ? tag.text : sdk.displayPartsToString(tag.text)}`,
                ),
              ]
                .filter(Boolean)
                .join('\n\n')
            : '';
          break;
        }
        case 'diagnostics':
          result.diagnostics = [
            ...service.getSyntacticDiagnostics(path),
            ...service.getSemanticDiagnostics(path),
            ...service.getSuggestionDiagnostics(path),
          ].map((diagnostic) => ({
            range: this.location(
              project,
              path,
              { start: diagnostic.start ?? 0, length: diagnostic.length ?? 0 },
              '',
              '',
            ).range,
            severity:
              diagnostic.category === sdk.DiagnosticCategory.Error
                ? 'error'
                : diagnostic.category === sdk.DiagnosticCategory.Warning
                  ? 'warning'
                  : 'information',
            message: sdk.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
            source: `TypeScript ${sdk.version} (${diagnostic.code})`,
          }));
          break;
        case 'format': {
          const changes = request.range
            ? service.getFormattingEditsForRange(
                path,
                this.offset(project, path, request.range.start),
                this.offset(project, path, request.range.end),
                format,
              )
            : service.getFormattingEditsForDocument(path, format);
          result.edits = changes.map((change) => this.edit(project, path, change));
          break;
        }
        case 'rename':
          result.edits = await this.rename(project, path, offset, request.newName ?? '', canceled);
          break;
        case 'symbols': {
          const locations: SourceLocation[] = [];
          if (request.query) {
            for (const context of this.projects.values())
              for (const item of context.service.getNavigateToItems(request.query))
                locations.push(
                  this.location(context, item.fileName, item.textSpan, item.name, 'symbol'),
                );
            if (this.failures.size) {
              result.state = 'partial';
              result.reasons.push(...this.failures.values());
            }
          } else {
            const visit = (node: ts.NavigationTree) => {
              locations.push(
                this.location(project, path, node.nameSpan ?? node.spans[0], node.text, 'symbol'),
              );
              node.childItems?.forEach(visit);
            };
            service.getNavigationTree(path).childItems?.forEach(visit);
          }
          result.symbols = [
            ...new Map(
              locations.map((location) => [
                `${location.path}:${location.range.start.line}:${location.range.start.character}:${location.name}`,
                location,
              ]),
            ).values(),
          ];
          break;
        }
        case 'codeActions': {
          result.codeActions = [];
          const imports = this.fileEdits(
            project,
            service.organizeImports({ type: 'file', fileName: path }, format, preferences),
          );
          if (imports.length)
            result.codeActions.push({
              title: 'Organize imports',
              kind: 'source.organizeImports',
              edits: imports,
            });
          const start = request.range ? this.offset(project, path, request.range.start) : offset;
          const end = request.range ? this.offset(project, path, request.range.end) : offset;
          const diagnostics = [
            ...service.getSyntacticDiagnostics(path),
            ...service.getSemanticDiagnostics(path),
          ].filter(
            (diagnostic) =>
              diagnostic.start !== undefined &&
              diagnostic.start <= end &&
              diagnostic.start + (diagnostic.length ?? 0) >= start,
          );
          const supported = new Set(sdk.getSupportedCodeFixes().map(Number));
          for (const diagnostic of diagnostics.filter((item) => supported.has(item.code))) {
            for (const fix of service.getCodeFixesAtPosition(
              path,
              diagnostic.start!,
              diagnostic.start! + (diagnostic.length ?? 0),
              [diagnostic.code],
              format,
              preferences,
            )) {
              if (!fix.commands?.length && !fix.changes.some((change) => change.isNewFile))
                result.codeActions.push({
                  title: fix.description,
                  kind: 'quickfix',
                  edits: this.fileEdits(project, fix.changes),
                });
            }
          }
          result.codeActions = [
            ...new Map(
              result.codeActions.map((action) => [JSON.stringify(action), action]),
            ).values(),
          ];
          break;
        }
        default:
          return {
            ...result,
            state: 'unsupported',
            reasons: [`Unsupported editor operation: ${request.operation}`],
          };
      }
      if (canceled())
        return { ...result, state: 'canceled', edits: undefined, reasons: ['Request canceled.'] };
      return result;
    } catch (error) {
      return {
        ...result,
        state: canceled() ? 'canceled' : 'failed',
        edits: undefined,
        reasons: [this.errorText(error)],
      };
    }
  }

  private edit(project: Project, path: string, change: ts.TextChange): SemanticEdit {
    path = canonical(path);
    if (!inside(this.root, path) || path.includes('/node_modules/'))
      throw new Error('Edit targets an external or dependency file.');
    const content = this.overlays.get(path)?.content ?? readFileSync(path, 'utf8');
    return {
      path,
      revision: this.overlays.get(path)?.revision ?? 0,
      fileHash: createHash('sha256').update(content).digest('hex'),
      range: this.location(project, path, change.span, '', '').range,
      newText: change.newText,
    };
  }

  private fileEdits(project: Project, changes: readonly ts.FileTextChanges[]): SemanticEdit[] {
    if (changes.some((change) => change.isNewFile))
      throw new Error(
        'This action requires creating a file, which is not supported by reviewed text edits.',
      );
    return changes.flatMap((change) =>
      change.textChanges.map((edit) => this.edit(project, change.fileName, edit)),
    );
  }

  private async rename(
    origin: Project,
    path: string,
    offset: number,
    newName: string,
    canceled: () => boolean,
  ): Promise<SemanticEdit[]> {
    const scanner = origin.sdk.createScanner(
      origin.sdk.ScriptTarget.Latest,
      false,
      origin.sdk.LanguageVariant.Standard,
      newName,
    );
    if (
      scanner.scan() !== origin.sdk.SyntaxKind.Identifier ||
      scanner.scan() !== origin.sdk.SyntaxKind.EndOfFileToken
    )
      throw new Error('Rename requires a valid, non-keyword identifier.');
    if (this.failures.size)
      throw new Error(
        `Rename requires all configured projects: ${[...this.failures.values()].join('; ')}`,
      );
    const info = origin.service.getRenameInfo(path, offset, { allowRenameOfImportPath: false });
    if (!info.canRename) throw new Error(info.localizedErrorMessage);
    if (info.fileToRename)
      throw new Error('File and module renames require resource operations and are not supported.');
    const anchors: Anchor[] = [
      { path, offset },
      ...(origin.service.getDefinitionAtPosition(path, offset) ?? []).map((item) => ({
        path: canonical(item.fileName),
        offset: item.textSpan.start,
      })),
    ];
    const edits = new Map<string, SemanticEdit>();
    for (const project of this.projects.values()) {
      await yieldTurn();
      if (canceled()) throw new Error('Rename canceled.');
      const coverage = this.coverageDiagnostics(project);
      if (coverage.length)
        throw new Error(`Rename requires complete context coverage: ${coverage.join('; ')}`);
      const points = this.sourceFile(project, path)
        ? [{ path, offset }]
        : anchors.filter((anchor) => this.sourceFile(project, anchor.path));
      for (const point of points) {
        for (const location of project.service.findRenameLocations(
          point.path,
          point.offset,
          false,
          false,
          true,
        ) ?? []) {
          const edit = this.edit(project, location.fileName, {
            span: location.textSpan,
            newText: `${location.prefixText ?? ''}${newName}${location.suffixText ?? ''}`,
          });
          const key = `${edit.path}:${JSON.stringify(edit.range)}`;
          const existing = edits.get(key);
          if (existing && existing.newText !== edit.newText)
            throw new Error('Projects disagree on the rename; no edits were produced.');
          edits.set(key, edit);
        }
      }
    }
    if (!edits.size) throw new Error('No rename locations could be resolved.');
    this.validateRename([...edits.values()]);
    return [...edits.values()];
  }

  private validateRename(edits: SemanticEdit[]) {
    const errors = () => {
      const counts = new Map<string, number>();
      for (const project of this.projects.values()) {
        const program = project.service.getProgram()!;
        for (const diagnostic of [
          ...program.getSyntacticDiagnostics(),
          ...program.getSemanticDiagnostics(),
        ]) {
          if (diagnostic.category !== project.sdk.DiagnosticCategory.Error) continue;
          const key = `${project.context.id}:${diagnostic.file?.fileName}:${diagnostic.code}:${project.sdk.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
      return counts;
    };
    const before = errors();
    const saved = new Map(this.overlays);
    try {
      for (const path of new Set(edits.map((edit) => edit.path))) {
        const content = this.overlays.get(path)?.content ?? readFileSync(path, 'utf8');
        const source = [...this.projects.values()]
          .map((project) => this.sourceFile(project, path))
          .find(Boolean)!;
        const changes = edits
          .filter((edit) => edit.path === path)
          .map((edit) => ({
            start: source.getPositionOfLineAndCharacter(
              edit.range.start.line,
              edit.range.start.character,
            ),
            end: source.getPositionOfLineAndCharacter(
              edit.range.end.line,
              edit.range.end.character,
            ),
            newText: edit.newText,
          }))
          .sort((a, b) => b.start - a.start);
        let updated = content;
        let previousStart = content.length;
        for (const change of changes) {
          if (change.end > previousStart) throw new Error('Rename edits overlap.');
          updated = updated.slice(0, change.start) + change.newText + updated.slice(change.end);
          previousStart = change.start;
        }
        this.overlays.set(path, {
          content: updated,
          revision: (this.overlays.get(path)?.revision ?? 0) + 1,
        });
      }
      this.version++;
      for (const [key, count] of errors())
        if (count > (before.get(key) ?? 0))
          throw new Error(
            `Rename would introduce a diagnostic: ${key.split(':').slice(3).join(':')}`,
          );
    } finally {
      this.overlays = saved;
      this.version++;
    }
  }

  async query(
    query: NavigationQuery,
    canceled: () => boolean = () => false,
    progress?: (batch: NavigationBatch) => void,
  ): Promise<NavigationBatch> {
    const batch: NavigationBatch = {
      id: query.id,
      documentRevision: query.documentRevision,
      workspaceGeneration: query.workspaceGeneration,
      state: 'complete',
      locations: [],
      searchedContexts: 0,
      totalContexts: 0,
      reasons: [],
    };
    if (!capabilities.includes(query.operation))
      return {
        ...batch,
        state: 'unsupported',
        reasons: [`Unsupported operation: ${query.operation}`],
      };
    if (query.workspaceGeneration !== this.generation)
      return {
        ...batch,
        state: 'failed',
        reasons: ['Workspace generation is obsolete; initialize this provider again.'],
      };
    if (!isAbsolute(query.path))
      return { ...batch, state: 'failed', reasons: ['Query paths must be absolute.'] };
    const path = canonical(query.path);
    if ((this.overlays.get(path)?.revision ?? 0) !== query.documentRevision)
      return {
        ...batch,
        state: 'failed',
        reasons: ['Document revision does not match the provider overlay.'],
      };
    if (isMarkup(path)) {
      if (!inside(this.root, path))
        return { ...batch, state: 'failed', reasons: ['Path is outside the workspace.'] };
      try {
        return markupNavigation(
          { ...query, path },
          this.overlays.get(path)?.content ?? readFileSync(path, 'utf8'),
          this.contexts
            .filter((context) => inside(context.root, path))
            .map((context) => context.id),
        );
      } catch (error) {
        return { ...batch, state: 'failed', reasons: [this.errorText(error)] };
      }
    }
    if (!/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(path))
      return {
        ...batch,
        state: 'unsupported',
        reasons: ['This provider does not support this language.'],
      };
    const selected = query.contextIds
      ? this.contexts.filter((context) => query.contextIds!.includes(context.id))
      : this.contexts;
    batch.totalContexts = selected.length;
    if (query.contextIds?.some((id) => !this.contexts.some((context) => context.id === id)))
      batch.reasons.push('The query includes unknown web context IDs.');
    if (!selected.length)
      return {
        ...batch,
        state: 'failed',
        reasons: [...batch.reasons, 'No configured web projects are available.'],
      };
    if (this.checkpointUsable()) {
      await yieldTurn();
      if (canceled()) return { ...batch, state: 'canceled', reasons: ['Query canceled.'] };
      const cached = this.checkpointQuery(query, path, selected, batch);
      if (cached) return cached;
    }
    this.ensureProjects();
    const merged = new Map<string, SourceLocation>();
    const originProjects = [...this.projects.values()].filter((project) =>
      this.sourceFile(project, path),
    );
    if (!originProjects.length)
      return {
        ...batch,
        state: 'failed',
        reasons: [
          'The query file is not included in any successfully loaded web context.',
          ...this.failures.values(),
        ],
      };
    let offset: number;
    try {
      offset = this.offset(originProjects[0], path, query.position);
    } catch (error) {
      return { ...batch, state: 'failed', reasons: [this.errorText(error)] };
    }
    const anchors: Anchor[] = [{ path, offset }];
    // A sibling context may know a shared declaration but not the originating use-site.
    for (const project of originProjects) {
      try {
        for (const definition of project.service.getDefinitionAtPosition(path, offset) ?? [])
          anchors.push({ path: canonical(definition.fileName), offset: definition.textSpan.start });
      } catch (error) {
        batch.reasons.push(
          `${project.context.id}: could not resolve query provenance: ${this.errorText(error)}`,
        );
      }
    }
    const uniqueAnchors = [
      ...new Map(anchors.map((anchor) => [`${anchor.path}:${anchor.offset}`, anchor])).values(),
    ];
    const reportProgress = () => {
      if (progress && !canceled())
        progress(structuredClone({ ...batch, state: 'loading', locations: [...merged.values()] }));
    };
    for (const context of selected) {
      await yieldTurn();
      if (canceled())
        return {
          ...batch,
          state: 'canceled',
          locations: [...merged.values()],
          reasons: [...batch.reasons, 'Query canceled.'],
        };
      const project = this.projects.get(context.id);
      if (!project) {
        batch.reasons.push(
          `${context.id}: ${this.failures.get(context.id) ?? 'Context is unavailable.'}`,
        );
        reportProgress();
        continue;
      }
      try {
        batch.reasons.push(
          ...this.coverageDiagnostics(project).map((reason) => `${context.id}: ${reason}`),
        );
        const applicable = uniqueAnchors.filter((anchor) => this.sourceFile(project, anchor.path));
        if (applicable.length) {
          // Prefer the original query point when available; mapped declarations are for other projects.
          const points = this.sourceFile(project, path) ? [{ path, offset }] : applicable;
          for (const point of points) {
            const locations = this.queryProject(project, query.operation, point);
            for (const location of locations) {
              const key = `${location.path}:${location.range.start.line}:${location.range.start.character}:${location.range.end.line}:${location.range.end.character}:${location.relationship}`;
              const existing = merged.get(key);
              if (existing)
                existing.contextIds = [
                  ...new Set([...existing.contextIds, ...location.contextIds]),
                ].sort();
              else merged.set(key, location);
            }
          }
        }
        batch.searchedContexts++;
      } catch (error) {
        batch.reasons.push(`${context.id}: ${this.errorText(error)}`);
      }
      reportProgress();
    }
    batch.locations = [...merged.values()].sort(
      (a, b) =>
        a.path.localeCompare(b.path) ||
        a.range.start.line - b.range.start.line ||
        a.range.start.character - b.range.start.character ||
        a.relationship.localeCompare(b.relationship),
    );
    if (canceled()) batch.state = 'canceled';
    else if (batch.searchedContexts === 0) batch.state = 'failed';
    else if (batch.reasons.length) batch.state = 'partial';
    return batch;
  }

  async workspaceSymbols(
    request: WorkspaceSymbolsRequest,
    canceled: () => boolean = () => false,
  ): Promise<NavigationBatch> {
    const batch: NavigationBatch = {
      id: request.id,
      documentRevision: 0,
      workspaceGeneration: request.workspaceGeneration,
      state: 'complete',
      locations: [],
      searchedContexts: 0,
      totalContexts: this.contexts.length,
      reasons: [],
    };
    if (request.workspaceGeneration !== this.generation)
      return {
        ...batch,
        state: 'failed',
        reasons: ['Workspace generation is obsolete; initialize this provider again.'],
      };
    const query = request.query.trim();
    if (!query || query.length > 200)
      return {
        ...batch,
        state: 'failed',
        reasons: ['Symbol search requires between 1 and 200 characters.'],
      };
    this.ensureProjects();
    const locations = new Map<string, SourceLocation>();
    for (const context of this.contexts) {
      await yieldTurn();
      if (canceled())
        return {
          ...batch,
          state: 'canceled',
          locations: [...locations.values()],
          reasons: [...batch.reasons, 'Symbol search canceled.'],
        };
      const project = this.projects.get(context.id);
      if (!project) {
        batch.reasons.push(
          `${context.id}: ${this.failures.get(context.id) ?? 'Context is unavailable.'}`,
        );
        continue;
      }
      try {
        batch.reasons.push(
          ...this.coverageDiagnostics(project).map((reason) => `${context.id}: ${reason}`),
        );
        const found = project.service.getNavigateToItems(query, 1000, undefined, true, true);
        if (found.length >= 1000)
          batch.reasons.push(
            `${context.id}: symbol results reached the 1,000 item limit; refine the search.`,
          );
        for (const item of found) {
          const path = canonical(item.fileName);
          if (!inside(this.root, path) || path.includes('/node_modules/')) continue;
          const location = this.location(project, path, item.textSpan, item.name, 'symbol');
          const key = `${path}:${location.range.start.line}:${location.range.start.character}:${location.name}`;
          const existing = locations.get(key);
          if (existing)
            existing.contextIds = [...new Set([...existing.contextIds, context.id])].sort();
          else locations.set(key, location);
        }
        batch.searchedContexts++;
      } catch (error) {
        batch.reasons.push(`${context.id}: ${this.errorText(error)}`);
      }
    }
    batch.locations = [...locations.values()].sort(
      (a, b) =>
        (a.name ?? '').localeCompare(b.name ?? '') ||
        a.path.localeCompare(b.path) ||
        a.range.start.line - b.range.start.line,
    );
    if (canceled()) batch.state = 'canceled';
    else if (!batch.searchedContexts) {
      batch.state = 'failed';
      if (!batch.reasons.length) batch.reasons.push('No configured web projects are available.');
    } else if (batch.reasons.length) batch.state = 'partial';
    return batch;
  }

  private checkpointQuery(
    query: NavigationQuery,
    path: string,
    selected: BuildContext[],
    base: NavigationBatch,
  ): NavigationBatch | null {
    const data = this.checkpoint;
    if (!data) return null;
    const locate = (
      project: ProjectIndex,
      file: string,
      offset: number,
      operation: NavigationOperation,
    ): IndexValue | undefined => {
      const token = project.files[file]?.tokens.find(
        (token) => token.start <= offset && offset < token.end,
      );
      const key = token?.operations[operation];
      return key ? data.values[key] : undefined;
    };
    const origins = data.projects.filter((project) => project.files[path]);
    const source = origins[0]?.files[path];
    const { line, character } = query.position;
    if (
      !source ||
      !Number.isSafeInteger(line) ||
      !Number.isSafeInteger(character) ||
      line < 0 ||
      character < 0 ||
      line >= source.lines.length
    )
      return null;
    const offset = source.lines[line] + character;
    if (offset > (source.lines[line + 1] ?? source.length)) return null;
    const anchors: Anchor[] = [{ path, offset }];
    for (const origin of origins) {
      const definition = locate(origin, path, offset, 'definition');
      if (!definition || definition.error) return null;
      for (const location of definition.locations) {
        const file = data.projects.find((project) => project.files[location.path])?.files[
          location.path
        ];
        if (file)
          anchors.push({
            path: location.path,
            offset: file.lines[location.range.start.line] + location.range.start.character,
          });
      }
    }
    const unique = [
      ...new Map(anchors.map((anchor) => [`${anchor.path}:${anchor.offset}`, anchor])).values(),
    ];
    const result = { ...base, reasons: [...base.reasons], locations: [] as SourceLocation[] };
    const merged = new Map<string, SourceLocation>();
    for (const context of selected) {
      const project = data.projects.find((project) => project.id === context.id);
      if (!project) return null;
      result.reasons.push(...project.reasons.map((reason) => `${context.id}: ${reason}`));
      const points = project.files[path]
        ? [{ path, offset }]
        : unique.filter((anchor) => project.files[anchor.path]);
      let failed = false;
      for (const point of points) {
        const value = locate(project, point.path, point.offset, query.operation);
        if (!value) return null;
        if (value.error) {
          result.reasons.push(`${context.id}: ${value.error}`);
          failed = true;
          break;
        }
        for (const location of value.locations) {
          const key = `${location.path}:${location.range.start.line}:${location.range.start.character}:${location.range.end.line}:${location.range.end.character}:${location.relationship}`;
          const previous = merged.get(key);
          if (previous)
            previous.contextIds = [
              ...new Set([...previous.contextIds, ...location.contextIds]),
            ].sort();
          else merged.set(key, structuredClone(location));
        }
      }
      if (!failed) result.searchedContexts++;
    }
    result.locations = [...merged.values()].sort(
      (a, b) =>
        a.path.localeCompare(b.path) ||
        a.range.start.line - b.range.start.line ||
        a.range.start.character - b.range.start.character ||
        a.relationship.localeCompare(b.relationship),
    );
    result.state = !result.searchedContexts
      ? 'failed'
      : result.reasons.length
        ? 'partial'
        : 'complete';
    return result;
  }

  indexWorkspace(restoreOnly = false) {
    if (restoreOnly) {
      for (const context of this.contexts)
        if (!this.indexProgress.has(context.id))
          this.indexProgress.set(context.id, {
            indexState: 'missing',
            indexReason: 'No valid saved web index; eager indexing is disabled.',
          });
      return this.workspaceStatus();
    }
    this.indexEager = true;
    if (!this.persistentIndex) {
      for (const context of this.contexts)
        this.indexProgress.set(context.id, {
          indexState: 'failed',
          indexReason: 'Persistent web index storage is unavailable.',
        });
      return this.workspaceStatus();
    }
    if (this.indexTask) {
      this.pendingIndex = true;
      return this.workspaceStatus();
    }
    for (const [path, overlay] of this.overlays) {
      if (fileHash(path) !== hash(overlay.content)) {
        for (const context of this.contexts)
          this.indexProgress.set(context.id, {
            indexState: 'invalidated',
            indexReason:
              'Unsaved buffers use live analysis; the saved-file checkpoint is retained.',
          });
        return this.workspaceStatus();
      }
    }
    if (this.checkpoint?.complete) {
      try {
        if (indexCurrent(this.checkpoint)) return this.workspaceStatus();
      } catch {
        /* Rebuild safely. */
      }
    }
    const version = this.version;
    const lifecycle = this.lifecycle;
    for (const context of this.contexts)
      this.indexProgress.set(context.id, {
        indexState: 'building',
        indexed: 0,
        packages: 0,
        indexUnits: 'files',
      });
    this.indexTask = this.buildWorkspaceIndex(version)
      .catch((error: unknown) => {
        if (version === this.version)
          for (const context of this.contexts)
            this.indexProgress.set(context.id, {
              indexState: 'failed',
              indexReason: this.errorText(error),
            });
      })
      .finally(() => {
        if (lifecycle !== this.lifecycle) return;
        this.indexTask = undefined;
        if (this.pendingIndex && this.indexEager) {
          this.pendingIndex = false;
          this.indexWorkspace();
        }
      });
    return this.workspaceStatus();
  }
  async checkpointWorkspace() {
    this.indexWorkspace();
    await this.indexTask;
    return this.workspaceStatus();
  }
  private async buildWorkspaceIndex(version: number) {
    await yieldTurn();
    const check = () => {
      if (this.version !== version) throw new Error('Workspace changed during indexing.');
    };
    check();
    this.ensureProjects();
    const data: WorkspaceIndex = {
      schema: 1,
      root: this.root,
      identity: this.checkpointIdentity,
      complete: false,
      files: {},
      directories: directoryInputs(this.root),
      projects: [],
      values: {},
    };
    const store = (value: IndexValue) => {
      const key = hash(JSON.stringify(value));
      data.values[key] = value;
      return key;
    };
    for (const context of this.contexts) {
      check();
      const project = this.projects.get(context.id);
      if (!project) {
        this.indexProgress.set(context.id, {
          indexState: 'failed',
          indexReason: this.failures.get(context.id) ?? 'Project is unavailable.',
        });
        continue;
      }
      if (project.indexError) throw new Error(project.indexError);
      const { sdk, service } = project;
      const program = service.getProgram();
      if (!program) throw new Error(`${context.id}: compiler program is unavailable.`);
      const entry: ProjectIndex = {
        id: context.id,
        files: {},
        reasons: this.coverageDiagnostics(project),
        metadata: {
          sdkVersion: sdk.version,
          sdkPath: project.sdkPath,
          sdkSource: project.sdkSource,
          diagnostics: project.diagnostics,
          plugins: project.plugins,
        },
      };
      // Record all source/dependency contents actually consumed by this program.
      for (const source of program.getSourceFiles()) {
        const path = canonical(source.fileName);
        entry.files[path] = {
          length: source.text.length,
          lines: [...source.getLineStarts()],
          tokens: [],
        };
        data.files[path] = hash(source.text);
      }
      const sources = program
        .getSourceFiles()
        .filter(
          (source) =>
            inside(this.root, canonical(source.fileName)) &&
            !canonical(source.fileName).includes('/node_modules/'),
        );
      let done = 0,
        visited = 0;
      for (const source of sources) {
        const path = canonical(source.fileName);
        const file = entry.files[path];
        const nodes: ts.Node[] = [];
        const visit = (node: ts.Node) => {
          if (
            sdk.isIdentifier(node) ||
            sdk.isPrivateIdentifier(node) ||
            sdk.isStringLiteral(node) ||
            node.kind === sdk.SyntaxKind.ThisKeyword ||
            node.kind === sdk.SyntaxKind.SuperKeyword
          )
            nodes.push(node);
          sdk.forEachChild(node, visit);
        };
        visit(source);
        for (const node of nodes) {
          check();
          const string = sdk.isStringLiteral(node);
          const start = node.getStart(source) + (string ? 1 : 0);
          const end = node.getEnd() - (string ? 1 : 0);
          if (end < start) continue;
          const token: IndexToken = { start, end, operations: {} };
          const operations: NavigationOperation[] = ['definition', 'typeDefinition', 'references'];
          const parent = node.parent;
          if (
            'name' in parent &&
            (parent as ts.NamedDeclaration).name === node &&
            (sdk.isClassDeclaration(parent) ||
              sdk.isInterfaceDeclaration(parent) ||
              sdk.isFunctionDeclaration(parent) ||
              sdk.isMethodDeclaration(parent) ||
              sdk.isMethodSignature(parent) ||
              sdk.isTypeAliasDeclaration(parent) ||
              (sdk.isVariableDeclaration(parent) &&
                parent.initializer &&
                (sdk.isArrowFunction(parent.initializer) ||
                  sdk.isFunctionExpression(parent.initializer))))
          )
            operations.push('implementations', 'typeHierarchy', 'incomingCalls', 'outgoingCalls');
          for (const operation of operations) {
            let value: IndexValue;
            try {
              value = { locations: this.queryProject(project, operation, { path, offset: start }) };
            } catch (error) {
              value = { locations: [], error: this.errorText(error) };
            }
            token.operations[operation] = store(value);
          }
          file.tokens.push(token);
          if (++visited % 16 === 0) {
            await yieldTurn();
            check();
          }
        }
        file.tokens.sort((a, b) => a.start - b.start || a.end - b.end);
        file.editor = {};
        for (const operation of ['diagnostics', 'symbols'] as const) {
          const response = await this.editor(
            {
              id: 'checkpoint',
              operation,
              path,
              documentRevision: this.overlays.get(path)?.revision ?? 0,
              workspaceGeneration: this.generation,
            },
            () => this.version !== version,
          );
          check();
          file.editor[operation] = {
            state: response.state,
            reasons: response.reasons,
            diagnostics: response.diagnostics,
            symbols: response.symbols,
          };
        }
        this.indexProgress.set(context.id, {
          indexState: 'building',
          indexed: ++done,
          packages: sources.length,
          indexUnits: 'files',
        });
        await yieldTurn();
      }
      check();
      Object.assign(data.files, project.inputFiles);
      // Program text wins over a later resolver probe of the same source file.
      for (const source of program.getSourceFiles())
        data.files[canonical(source.fileName)] = hash(source.text);
      Object.assign(data.directories, project.inputDirectories);
      for (const plugin of project.plugins) {
        if (!plugin.path) continue;
        data.files[plugin.path] = fileHash(plugin.path);
        // Next's entry loads helper modules that can change independently of its manifest.
        const marker = `${sep}node_modules${sep}next${sep}`;
        const end = plugin.path.lastIndexOf(marker);
        const packageRoot =
          end >= 0 ? plugin.path.slice(0, end + marker.length) : dirname(plugin.path);
        for (const loaded of Object.keys(require.cache))
          if (loaded.startsWith(packageRoot)) data.files[loaded] = fileHash(loaded);
      }
      data.projects.push(entry);
      data.complete =
        data.projects.length === this.contexts.length &&
        data.projects.every((project) => project.reasons.length === 0);
      this.indexStore.save(data);
      this.indexProgress.set(context.id, {
        indexState: 'built',
        indexReason: entry.reasons.join('; ') || undefined,
        indexed: sources.length,
        packages: sources.length,
        indexUnits: 'files',
      });
    }
    check();
    this.checkpoint = data;
  }

  dispose() {
    this.lifecycle++;
    this.indexTask = undefined;
    this.checkpoint = null;
    this.indexProgress.clear();
    this.indexEager = false;
    this.pendingIndex = false;
    for (const project of this.projects.values()) project.service.dispose();
    this.projects.clear();
    this.failures.clear();
    this.overlays.clear();
    this.version++;
  }

  private createProject(context: BuildContext): Project {
    if (!inside(this.root, context.root) || !inside(this.root, context.configPath))
      throw new Error('Project configuration is outside the workspace.');
    const { sdk, path, source, diagnostics } = loadSdk(context.root);
    const inputFiles: Record<string, string> = {};
    const inputDirectories: Record<string, string> = {};
    let indexError: string | undefined;
    const record = (operation: () => void) => {
      if (!this.persistentIndex) return;
      try {
        operation();
      } catch (error) {
        indexError = `Cannot validate web checkpoint inputs: ${this.errorText(error)}`;
      }
    };
    record(() => {
      inputFiles[path] = fileHash(path);
      Object.assign(inputDirectories, directoryInputs(context.root));
    });
    for (let dir = context.root; ; dir = dirname(dir)) {
      for (const candidate of [
        'node_modules/typescript/package.json',
        'node_modules/typescript/lib/typescript.js',
        'node_modules/next/package.json',
      ])
        record(() => {
          inputFiles[resolve(dir, candidate)] = fileHash(resolve(dir, candidate));
        });
      if (dirname(dir) === dir) break;
    }
    const readFile = (file: string) => {
      const text = this.overlays.get(canonical(file))?.content ?? sdk.sys.readFile(file);
      record(() => {
        inputFiles[resolve(file)] = text === undefined ? 'missing' : hash(text);
      });
      return text;
    };
    const fileExists = (file: string) => {
      const exists = this.overlays.has(canonical(file)) || sdk.sys.fileExists(file);
      record(() => {
        inputFiles[resolve(file)] = fileHash(resolve(file));
      });
      return exists;
    };
    const directoryExists = (dir: string) => {
      const exists = sdk.sys.directoryExists(dir);
      record(() => {
        if (exists) inputDirectories[resolve(dir)] = directoryHash(dir);
        else inputFiles[resolve(dir)] = 'missing';
      });
      return exists;
    };
    const config = sdk.readConfigFile(context.configPath, readFile);
    const explain = (diagnostic: ts.Diagnostic) =>
      sdk.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    if (config.error) throw new Error(explain(config.error));
    const parsed = sdk.parseJsonConfigFileContent(
      config.config,
      { ...sdk.sys, readFile, fileExists, directoryExists },
      dirname(context.configPath),
      undefined,
      context.configPath,
    );
    if (parsed.errors.length) throw new Error(parsed.errors.map(explain).join('\n'));
    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => parsed.options,
      getScriptFileNames: () => parsed.fileNames,
      getScriptVersion: (file) =>
        `${this.overlays.get(canonical(file))?.revision ?? 0}:${this.version}`,
      getProjectVersion: () => String(this.version),
      getScriptSnapshot: (file) => {
        const text = readFile(file);
        return text === undefined ? undefined : sdk.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => dirname(context.configPath),
      getDefaultLibFileName: (options) => sdk.getDefaultLibFilePath(options),
      readFile,
      fileExists,
      readDirectory: sdk.sys.readDirectory,
      directoryExists,
      getDirectories: sdk.sys.getDirectories,
      realpath: sdk.sys.realpath,
      useCaseSensitiveFileNames: () => sdk.sys.useCaseSensitiveFileNames,
      getProjectReferences: () => parsed.projectReferences,
    };
    const baseService = sdk.createLanguageService(host, sdk.createDocumentRegistry());
    const { service, plugins } = loadNextPlugin(
      sdk,
      context.configPath,
      parsed.options,
      host,
      baseService,
      this.enabledPackages.has('react-next'),
    );
    const program = service.getProgram();
    if (!program) {
      service.dispose();
      throw new Error('TypeScript could not create a project program.');
    }
    const configErrors = program
      .getOptionsDiagnostics()
      .filter((diagnostic) => diagnostic.category === sdk.DiagnosticCategory.Error);
    if (configErrors.length) {
      service.dispose();
      throw new Error(configErrors.map(explain).join('\n'));
    }
    return {
      context,
      sdk,
      sdkPath: path,
      sdkSource: source,
      service,
      diagnostics: [
        ...diagnostics,
        ...plugins.flatMap((plugin) => (plugin.reason ? [plugin.reason] : [])),
      ],
      plugins,
      inputFiles,
      inputDirectories,
      get indexError() {
        return indexError;
      },
      checkedVersion: -1,
      coverageReasons: [],
    };
  }

  private coverageDiagnostics(project: Project): string[] {
    if (project.checkedVersion === this.version) return project.coverageReasons;
    const program = project.service.getProgram()!;
    const diagnostics = [...program.getGlobalDiagnostics()];
    // Missing imports/types can hide references even in unopened consumer files.
    const resolutionErrors = new Set([2304, 2307, 2552, 2688, 2792, 2834, 2835, 6053, 6307, 7016]);
    for (const path of program.getRootFileNames()) {
      const file = program.getSourceFile(path);
      if (!file) continue;
      diagnostics.push(...program.getSyntacticDiagnostics(file));
      diagnostics.push(
        ...program
          .getSemanticDiagnostics(file)
          .filter((diagnostic) => resolutionErrors.has(diagnostic.code)),
      );
    }
    project.coverageReasons = [
      ...new Set([
        ...project.plugins.flatMap((plugin) => (plugin.reason ? [plugin.reason] : [])),
        ...diagnostics
          .filter((diagnostic) => diagnostic.category === project.sdk.DiagnosticCategory.Error)
          .map((diagnostic) =>
            project.sdk.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
          ),
      ]),
    ];
    project.checkedVersion = this.version;
    return project.coverageReasons;
  }

  private sourceFile(project: Project, path: string) {
    return project.service.getProgram()?.getSourceFile(path);
  }

  private offset(project: Project, path: string, position: Position): number {
    const source = this.sourceFile(project, path);
    if (
      !source ||
      !Number.isSafeInteger(position.line) ||
      !Number.isSafeInteger(position.character) ||
      position.line < 0 ||
      position.character < 0
    )
      throw new Error('Invalid source position.');
    const starts = source.getLineStarts();
    if (position.line >= starts.length) throw new Error('Source line is out of bounds.');
    const offset = starts[position.line] + position.character;
    const end = position.line + 1 < starts.length ? starts[position.line + 1] : source.text.length;
    if (offset > end) throw new Error('Source character is out of bounds.');
    return offset;
  }

  private location(
    project: Project,
    file: string,
    span: ts.TextSpan,
    name: string | undefined,
    relationship: string,
  ): SourceLocation {
    const path = canonical(file);
    const content =
      this.sourceFile(project, file) ??
      project.sdk.createSourceFile(
        file,
        this.overlays.get(path)?.content ?? readFileSync(path, 'utf8'),
        project.sdk.ScriptTarget.Latest,
      );
    const start = content.getLineAndCharacterOfPosition(span.start);
    const end = content.getLineAndCharacterOfPosition(span.start + span.length);
    return {
      path,
      range: { start, end },
      name: name || content.text.slice(span.start, span.start + span.length),
      preview: content.text.split(/\r?\n/)[start.line]?.trim() ?? '',
      contextIds: [project.context.id],
      relationship,
    };
  }

  private queryProject(
    project: Project,
    operation: NavigationOperation,
    point: Anchor,
  ): SourceLocation[] {
    const { service } = project;
    switch (operation) {
      case 'definition':
        return (service.getDefinitionAtPosition(point.path, point.offset) ?? []).map((item) =>
          this.location(project, item.fileName, item.textSpan, item.name, 'definition'),
        );
      case 'typeDefinition':
        return (service.getTypeDefinitionAtPosition(point.path, point.offset) ?? []).map((item) =>
          this.location(project, item.fileName, item.textSpan, item.name, 'typeDefinition'),
        );
      case 'references':
        return (service.getReferencesAtPosition(point.path, point.offset) ?? []).map((item) =>
          this.location(project, item.fileName, item.textSpan, undefined, 'reference'),
        );
      case 'implementations':
        return (service.getImplementationAtPosition(point.path, point.offset) ?? []).map((item) =>
          this.location(project, item.fileName, item.textSpan, undefined, 'implementation'),
        );
      case 'typeHierarchy':
        return this.explicitHierarchy(project, point);
      case 'incomingCalls':
      case 'outgoingCalls': {
        if (
          typeof service.prepareCallHierarchy !== 'function' ||
          typeof service.provideCallHierarchyIncomingCalls !== 'function' ||
          typeof service.provideCallHierarchyOutgoingCalls !== 'function'
        )
          throw new Error('This TypeScript SDK does not support call hierarchy.');
        const prepared = service.prepareCallHierarchy(point.path, point.offset);
        const items = prepared ? (Array.isArray(prepared) ? prepared : [prepared]) : [];
        const locations: SourceLocation[] = [];
        for (const item of items) {
          if (operation === 'incomingCalls') {
            for (const call of service.provideCallHierarchyIncomingCalls(
              item.file,
              item.selectionSpan.start,
            ))
              locations.push(
                this.location(
                  project,
                  call.from.file,
                  call.from.selectionSpan,
                  call.from.name,
                  'caller',
                ),
              );
          } else {
            for (const call of service.provideCallHierarchyOutgoingCalls(
              item.file,
              item.selectionSpan.start,
            ))
              locations.push(
                this.location(project, call.to.file, call.to.selectionSpan, call.to.name, 'callee'),
              );
          }
        }
        return locations;
      }
    }
  }

  /** Explicit extends/implements only; structural assignability is not inheritance. */
  private explicitHierarchy(project: Project, point: Anchor): SourceLocation[] {
    const { sdk } = project;
    const program = project.service.getProgram()!;
    const checker = program.getTypeChecker();
    const source = program.getSourceFile(point.path)!;
    let target: ts.Node = source;
    const descend = (node: ts.Node) => {
      if (node.getStart(source) <= point.offset && point.offset < node.getEnd()) {
        target = node;
        sdk.forEachChild(node, descend);
      }
    };
    descend(source);
    const unalias = (symbol: ts.Symbol | undefined) =>
      symbol && symbol.flags & sdk.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const declarationKeys = (symbol: ts.Symbol | undefined) =>
      (unalias(symbol)?.declarations ?? [])
        .filter(
          (node) =>
            sdk.isClassDeclaration(node) ||
            sdk.isClassExpression(node) ||
            sdk.isInterfaceDeclaration(node),
        )
        .map((node) => `${canonical(node.getSourceFile().fileName)}:${node.getStart()}`);
    let targetKeys = declarationKeys(checker.getSymbolAtLocation(target));
    if (!targetKeys.length)
      targetKeys = declarationKeys(checker.getTypeAtLocation(target).getSymbol());
    if (!targetKeys.length)
      throw new Error('Explicit type hierarchy requires a class or interface symbol.');
    const targets = new Set(targetKeys);
    const locations: SourceLocation[] = [];
    const add = (node: ts.ClassLikeDeclaration | ts.InterfaceDeclaration, relationship: string) => {
      const name = node.name;
      if (name)
        locations.push(
          this.location(
            project,
            node.getSourceFile().fileName,
            { start: name.getStart(), length: name.getWidth() },
            name.getText(),
            relationship,
          ),
        );
    };
    const visit = (node: ts.Node) => {
      if (
        sdk.isClassDeclaration(node) ||
        sdk.isClassExpression(node) ||
        sdk.isInterfaceDeclaration(node)
      ) {
        const childKey = `${canonical(node.getSourceFile().fileName)}:${node.getStart()}`;
        for (const clause of node.heritageClauses ?? [])
          for (const type of clause.types) {
            const symbol = unalias(
              checker.getSymbolAtLocation(type.expression) ??
                checker.getTypeAtLocation(type).getSymbol(),
            );
            const parents = (symbol?.declarations ?? []).filter(
              (declaration): declaration is ts.ClassLikeDeclaration | ts.InterfaceDeclaration =>
                sdk.isClassDeclaration(declaration) ||
                sdk.isClassExpression(declaration) ||
                sdk.isInterfaceDeclaration(declaration),
            );
            if (declarationKeys(symbol).some((key) => targets.has(key)))
              add(
                node,
                clause.token === sdk.SyntaxKind.ImplementsKeyword ? 'implementedBy' : 'extendedBy',
              );
            if (targets.has(childKey))
              for (const parent of parents)
                add(
                  parent,
                  clause.token === sdk.SyntaxKind.ImplementsKeyword ? 'implements' : 'extends',
                );
          }
      }
      sdk.forEachChild(node, visit);
    };
    // Loaded dependency declarations participate in explicit hierarchy just like
    // workspace source. Excluding .d.ts files silently hid library ancestry.
    for (const file of program.getSourceFiles())
      if (!program.isSourceFileDefaultLibrary(file) || file === source) visit(file);
    return locations;
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
