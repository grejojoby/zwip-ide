import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
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
};

export interface InitializeParams {
  root: string;
  contexts: BuildContext[];
  generation: number;
  enabledPackages?: string[];
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
    const seen = new Set<string>();
    for (const context of this.contexts) {
      if (seen.has(context.id)) throw new Error(`Duplicate context ID: ${context.id}`);
      seen.add(context.id);
      try {
        if (context.profileId || Object.keys(context.settings ?? {}).length)
          throw new Error(
            'Web build profiles must use separate tsconfig/jsconfig files; custom profile settings are unsupported.',
          );
        this.projects.set(context.id, this.createProject(context));
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
      ...this.workspaceStatus(),
    };
  }

  workspaceStatus() {
    return {
      generation: this.generation,
      contexts: this.contexts.map((context) => {
        const project = this.projects.get(context.id);
        return {
          ...context,
          state: project ? 'ready' : 'failed',
          reason: this.failures.get(context.id),
          sdkVersion: project?.sdk.version,
          sdkPath: project?.sdkPath,
          sdkSource: project?.sdkSource,
          diagnostics: project?.diagnostics ?? [],
          plugins: project?.plugins ?? [],
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

  dispose() {
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
    const config = sdk.readConfigFile(context.configPath, sdk.sys.readFile);
    const explain = (diagnostic: ts.Diagnostic) =>
      sdk.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    if (config.error) throw new Error(explain(config.error));
    const parsed = sdk.parseJsonConfigFileContent(
      config.config,
      sdk.sys,
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
        const text = this.overlays.get(canonical(file))?.content ?? sdk.sys.readFile(file);
        return text === undefined ? undefined : sdk.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => dirname(context.configPath),
      getDefaultLibFileName: (options) => sdk.getDefaultLibFilePath(options),
      readFile: (file) => this.overlays.get(canonical(file))?.content ?? sdk.sys.readFile(file),
      fileExists: (file) => this.overlays.has(canonical(file)) || sdk.sys.fileExists(file),
      readDirectory: sdk.sys.readDirectory,
      directoryExists: sdk.sys.directoryExists,
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
