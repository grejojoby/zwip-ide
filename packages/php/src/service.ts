import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type {
  BuildContext,
  EditorResult,
  NavigationBatch,
  Position,
  SourceLocation,
  SemanticDiagnostic,
} from '../../../src/contracts';

// Only this trusted program executes. Source arrives on stdin and is tokenized, never evaluated.
const tokenize = String.raw`
$source = stream_get_contents(STDIN);
$error = null;
try { token_get_all($source, TOKEN_PARSE); }
catch (ParseError $e) { $error = ['message' => $e->getMessage(), 'line' => $e->getLine()]; }
$tokens = [];
foreach (token_get_all($source) as $token) {
  $tokens[] = is_array($token) ? [token_name($token[0]), $token[1]] : [$token, $token];
}
echo json_encode(['tokens' => $tokens, 'error' => $error], JSON_INVALID_UTF8_SUBSTITUTE | JSON_THROW_ON_ERROR);
`;
type Input = {
  root: string;
  generation: number;
  contexts: BuildContext[];
  files?: { path: string }[];
};
type Request = {
  id: string;
  path: string;
  operation: string;
  documentRevision: number;
  workspaceGeneration: number;
  position?: Position;
  contextIds?: string[];
  sourceContextId?: string;
  query?: string;
};
type Token = { kind: string; text: string; start: number; end: number };
type Parsed = {
  content: string;
  revision: number;
  tokens: Token[];
  symbols: SourceLocation[];
  diagnostics: SemanticDiagnostic[];
};
const limitations =
  'PHP declaration/name candidates only; namespaces, imports, receiver types, inheritance, dynamic dispatch and Composer autoload resolution are not resolved.';
const canonical = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};
const inside = (root: string, path: string) => {
  const part = relative(root, path);
  return part === '' || (part !== '..' && !part.startsWith('../') && !isAbsolute(part));
};
const phpFile = (path: string) => /\.(php|phtml|php8)$/i.test(path);
function position(content: string, offset: number): Position {
  const lines = content.slice(0, offset).split('\n');
  return { line: lines.length - 1, character: lines.at(-1)!.length };
}
function offset(content: string, pos: Position): number {
  const lines = content.split('\n');
  if (
    !Number.isSafeInteger(pos.line) ||
    !Number.isSafeInteger(pos.character) ||
    pos.line < 0 ||
    pos.line >= lines.length ||
    pos.character < 0 ||
    pos.character > lines[pos.line].length
  )
    throw new Error('Invalid UTF-16 position.');
  return lines.slice(0, pos.line).reduce((sum, line) => sum + line.length + 1, 0) + pos.character;
}

export class PhpService {
  private root = '';
  private generation = -1;
  private contexts: BuildContext[] = [];
  private files = new Set<string>();
  private overlays = new Map<string, { content: string; revision: number }>();
  private cache = new Map<string, Parsed>();
  constructor(private binary = process.env.ZWIP_PHP_BINARY || 'php') {}
  private run(program: string, input = ''): string {
    const result = spawnSync(this.binary, ['-n', '-d', 'memory_limit=128M', '-r', program], {
      input,
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 32 * 1024 * 1024,
      cwd: this.root || undefined,
    });
    if (result.error || result.status !== 0)
      throw new Error(
        `PHP SDK failed (${this.binary}): ${result.error?.message || result.stderr || result.stdout}. Install PHP CLI with tokenizer and set ZWIP_PHP_BINARY to its absolute path.`,
      );
    return result.stdout;
  }
  initialize(params: Input) {
    if (
      !isAbsolute(params.root) ||
      !Number.isSafeInteger(params.generation) ||
      !Array.isArray(params.contexts)
    )
      throw new Error('Invalid initialization.');
    this.dispose();
    this.root = canonical(params.root);
    this.generation = params.generation;
    this.contexts = params.contexts
      .filter((c) => c.language === 'php')
      .map((c) => ({ ...c, root: canonical(c.root) }));
    if (
      this.contexts.some(
        (c) => !inside(this.root, c.root) || c.profileId || Object.keys(c.settings ?? {}).length,
      )
    )
      throw new Error('PHP custom build profiles and external contexts are unsupported.');
    this.files = new Set(
      (params.files ?? [])
        .map((f) => canonical(f.path))
        .filter((p) => inside(this.root, p) && phpFile(p)),
    );
    const version = this.run(
      'if (!function_exists("token_get_all") || PHP_VERSION_ID < 80000) { fwrite(STDERR, "PHP 8+ with tokenizer required"); exit(1); } echo PHP_VERSION;',
    );
    return {
      capabilities: [
        'definition',
        'references',
        'completion',
        'hover',
        'diagnostics',
        'symbols',
        'workspaceSymbols',
      ],
      sdkVersion: version,
      ...this.workspaceStatus(),
    };
  }
  workspaceStatus() {
    return {
      generation: this.generation,
      contexts: this.contexts.map((c) => ({ ...c, state: 'ready', reason: limitations })),
    };
  }
  private path(path: string): string {
    if (!isAbsolute(path)) throw new Error('Absolute PHP path required.');
    const p = canonical(path);
    if (!inside(this.root, p) || !phpFile(p) || !this.files.has(p))
      throw new Error('PHP document is outside the included workspace files.');
    return p;
  }
  updateDocument(update: { path: string; content: string; revision: number }) {
    const path = this.path(update.path),
      prior = this.overlays.get(path);
    if (
      typeof update.content !== 'string' ||
      !Number.isSafeInteger(update.revision) ||
      update.revision < 0 ||
      (prior &&
        (update.revision < prior.revision ||
          (update.revision === prior.revision && update.content !== prior.content)))
    )
      throw new Error('Invalid or obsolete document revision.');
    this.overlays.set(path, { content: update.content, revision: update.revision });
    this.cache.delete(path);
    return { path, revision: update.revision, workspaceGeneration: this.generation };
  }
  closeDocument(path: string) {
    path = this.path(path);
    this.overlays.delete(path);
    this.cache.delete(path);
    return { path };
  }
  workspaceChanged(paths: string[]) {
    for (const path of paths) {
      if (!isAbsolute(path) || !inside(this.root, canonical(path)))
        throw new Error('Changed path is outside workspace.');
      this.cache.delete(canonical(path));
    }
    return this.workspaceStatus();
  }
  private parse(path: string): Parsed {
    this.path(path);
    const overlay = this.overlays.get(path),
      content = overlay?.content ?? readFileSync(path, 'utf8'),
      revision = overlay?.revision ?? 0;
    const cached = this.cache.get(path);
    if (cached?.content === content && cached.revision === revision) return cached;
    if (Buffer.byteLength(content) > 1024 * 1024)
      throw new Error('PHP analysis is limited to 1 MiB per file.');
    const raw = JSON.parse(this.run(tokenize, content)) as {
      tokens: [string, string][];
      error: null | { message: string; line: number };
    };
    let start = 0;
    const tokens = raw.tokens.map(([kind, text]) => {
      const token = { kind, text, start, end: start + text.length };
      start += text.length;
      return token;
    });
    const significant = tokens.filter(
      (t) => !['T_WHITESPACE', 'T_COMMENT', 'T_DOC_COMMENT'].includes(t.kind),
    );
    const symbols: SourceLocation[] = [];
    const declarations = new Set([
      'T_CLASS',
      'T_INTERFACE',
      'T_TRAIT',
      'T_ENUM',
      'T_FUNCTION',
      'T_CONST',
    ]);
    significant.forEach((t, i) => {
      if (!declarations.has(t.kind)) return;
      // ::class is an expression, anonymous functions/classes have no name token.
      if (t.kind === 'T_CLASS' && significant[i - 1]?.kind === 'T_DOUBLE_COLON') return;
      let name = significant[i + 1];
      if (name?.text === '&') name = significant[i + 2];
      if (name?.kind !== 'T_STRING') return;
      symbols.push({
        path,
        name: name.text,
        range: { start: position(content, name.start), end: position(content, name.end) },
        preview: content.split('\n')[position(content, t.start).line].trim(),
        contextIds: this.contexts.filter((c) => inside(c.root, path)).map((c) => c.id),
        relationship: 'declaration candidate',
      });
    });
    const diagnostics: SemanticDiagnostic[] = raw.error
      ? [
          {
            range: {
              start: { line: Math.max(0, raw.error.line - 1), character: 0 },
              end: { line: Math.max(0, raw.error.line - 1), character: 1 },
            },
            severity: 'error',
            message: raw.error.message,
            source: 'PHP parser',
          },
        ]
      : [];
    const parsed = { content, revision, tokens, symbols, diagnostics };
    this.cache.set(path, parsed);
    return parsed;
  }
  private validate(request: Request): Parsed {
    if (request.workspaceGeneration !== this.generation)
      throw new Error('Stale workspace generation.');
    const file = this.parse(this.path(request.path));
    if (file.revision !== request.documentRevision) throw new Error('Stale document revision.');
    if (
      request.sourceContextId &&
      !this.contexts.some(
        (c) => c.id === request.sourceContextId && inside(c.root, canonical(request.path)),
      )
    )
      throw new Error('Unknown PHP source context.');
    return file;
  }
  private allSymbols(): {
    symbols: SourceLocation[];
    reasons: string[];
    documents: Map<string, Parsed>;
    searchedContexts: number;
  } {
    const documents = new Map<string, Parsed>();
    const symbols: SourceLocation[] = [],
      reasons = [limitations];
    const deadline = Date.now() + 5000;
    for (const path of [...this.files].slice(0, 2000)) {
      if (Date.now() > deadline) {
        reasons.push('PHP workspace analysis exceeded its five-second budget.');
        break;
      }
      try {
        const file = this.parse(path);
        documents.set(path, file);
        symbols.push(...file.symbols);
        if (file.diagnostics.length) reasons.push(`Parse errors in ${relative(this.root, path)}.`);
      } catch (error) {
        reasons.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (this.files.size > 2000) reasons.push('Workspace analysis limited to 2000 PHP files.');
    const searchedContexts = this.contexts.filter((c) =>
      [...this.files].filter((p) => inside(c.root, p)).every((p) => documents.has(p)),
    ).length;
    return { symbols, reasons, documents, searchedContexts };
  }
  editor(request: Request): EditorResult {
    const base = {
      id: request.id,
      documentRevision: request.documentRevision,
      workspaceGeneration: this.generation,
    };
    try {
      const file = this.validate(request);
      if (request.operation === 'diagnostics')
        return {
          ...base,
          state: 'partial',
          reasons: ['Syntax diagnostics only; type checking and runtime errors are not analyzed.'],
          diagnostics: file.diagnostics,
        };
      if (request.operation === 'symbols')
        return {
          ...base,
          state: 'partial',
          reasons: [
            'Named declarations only; properties, parameters and additional names in const lists are not included.',
            ...(file.diagnostics.length ? ['File contains parse errors.'] : []),
          ],
          symbols: file.symbols.filter((s) =>
            s.name.toLowerCase().includes((request.query ?? '').toLowerCase()),
          ),
        };
      if (!['completion', 'hover'].includes(request.operation))
        return {
          ...base,
          state: 'unsupported',
          reasons: [`PHP ${request.operation} is unsupported.`],
        };
      if (!request.position) throw new Error('Position required.');
      const at = offset(file.content, request.position),
        token = file.tokens.find(
          (t) =>
            t.start <= at &&
            at <= t.end &&
            ['T_STRING', 'T_VARIABLE', 'T_NAME_QUALIFIED', 'T_NAME_FULLY_QUALIFIED'].includes(
              t.kind,
            ),
        );
      const surrounding = file.tokens.find((t) => t.start <= at && at < t.end);
      if (
        surrounding &&
        [
          'T_COMMENT',
          'T_DOC_COMMENT',
          'T_CONSTANT_ENCAPSED_STRING',
          'T_ENCAPSED_AND_WHITESPACE',
          'T_INLINE_HTML',
        ].includes(surrounding.kind)
      ) {
        return {
          ...base,
          state: 'partial',
          reasons: [limitations],
          ...(request.operation === 'completion' ? { completions: [] } : { hover: '' }),
        };
      }
      const { symbols, reasons } = this.allSymbols();
      if (request.operation === 'hover')
        return {
          ...base,
          state: 'partial',
          reasons,
          hover: symbols
            .filter((s) => s.name.toLowerCase() === token?.text.toLowerCase())
            .map((s) => `${s.preview}\n${relative(this.root, s.path)}`)
            .join('\n\n'),
        };
      const prefix = token ? file.content.slice(token.start, at) : '';
      const labels = [
        ...new Set([
          ...symbols.map((s) => s.name),
          ...file.tokens.filter((t) => t.kind === 'T_VARIABLE').map((t) => t.text),
          'class',
          'function',
          'namespace',
          'use',
          'return',
          'public',
          'private',
          'protected',
          'static',
          'new',
          'if',
          'else',
          'foreach',
          'match',
          'readonly',
        ]),
      ];
      return {
        ...base,
        state: 'partial',
        reasons,
        completions: labels
          .filter((label) => label.toLowerCase().startsWith(prefix.toLowerCase()))
          .slice(0, 500)
          .map((label) => ({
            label,
            insertText: label,
            detail: 'PHP name candidate',
            range: {
              start: position(file.content, token?.start ?? at),
              end: position(file.content, token?.end ?? at),
            },
          })),
      };
    } catch (error) {
      return {
        ...base,
        state: 'failed',
        reasons: [error instanceof Error ? error.message : String(error)],
      };
    }
  }
  query(request: Request): NavigationBatch {
    const base = {
      id: request.id,
      documentRevision: request.documentRevision,
      workspaceGeneration: this.generation,
      locations: [] as SourceLocation[],
      searchedContexts: 0,
      totalContexts: this.contexts.length,
    };
    try {
      const file = this.validate(request);
      if (!['definition', 'references'].includes(request.operation))
        return {
          ...base,
          state: 'unsupported',
          reasons: [`PHP ${request.operation} is unsupported.`],
        };
      if (!request.position) throw new Error('Position required.');
      const at = offset(file.content, request.position),
        token = file.tokens.find(
          (t) =>
            t.start <= at &&
            at < t.end &&
            ['T_STRING', 'T_NAME_QUALIFIED', 'T_NAME_FULLY_QUALIFIED'].includes(t.kind),
        );
      if (!token)
        return {
          ...base,
          state: 'partial',
          reasons: [limitations, 'No supported PHP identifier at this position.'],
        };
      const { symbols, reasons, documents, searchedContexts } = this.allSymbols();
      let locations = symbols.filter((s) => s.name.toLowerCase() === token.text.toLowerCase());
      if (request.operation === 'references') {
        locations = [];
        for (const [path, f] of documents) {
          for (const t of f.tokens) {
            if (
              ['T_STRING', 'T_NAME_QUALIFIED', 'T_NAME_FULLY_QUALIFIED'].includes(t.kind) &&
              t.text.toLowerCase() === token.text.toLowerCase()
            ) {
              locations.push({
                path,
                name: t.text,
                range: { start: position(f.content, t.start), end: position(f.content, t.end) },
                preview: f.content.split('\n')[position(f.content, t.start).line].trim(),
                contextIds: this.contexts.filter((c) => inside(c.root, path)).map((c) => c.id),
                relationship: 'name occurrence candidate',
              });
            }
          }
        }
      }
      if (request.contextIds) {
        if (request.contextIds.some((id) => !this.contexts.some((c) => c.id === id)))
          throw new Error('Unknown PHP context.');
        locations = locations.filter((s) =>
          s.contextIds.some((id) => request.contextIds!.includes(id)),
        );
      }
      if (locations.length > 10000) reasons.push('Results limited to 10000 locations.');
      return {
        ...base,
        state: 'partial',
        reasons,
        locations: locations.slice(0, 10000),
        searchedContexts,
      };
    } catch (error) {
      return {
        ...base,
        state: 'failed',
        reasons: [error instanceof Error ? error.message : String(error)],
      };
    }
  }
  workspaceSymbols(request: {
    id: string;
    query: string;
    workspaceGeneration: number;
  }): NavigationBatch {
    const base = {
      id: request.id,
      documentRevision: 0,
      workspaceGeneration: this.generation,
      searchedContexts: 0,
      totalContexts: this.contexts.length,
      locations: [] as SourceLocation[],
    };
    if (request.workspaceGeneration !== this.generation)
      return { ...base, state: 'failed', reasons: ['Stale workspace generation.'] };
    const { symbols, reasons, searchedContexts } = this.allSymbols();
    const matches = symbols.filter((s) =>
      s.name.toLowerCase().includes(request.query.toLowerCase()),
    );
    if (matches.length > 10000) reasons.push('Results limited to 10000 locations.');
    return {
      ...base,
      state: 'partial',
      reasons,
      locations: matches.slice(0, 10000),
      searchedContexts,
    };
  }
  indexWorkspace() {
    this.allSymbols();
    return this.workspaceStatus();
  }
  checkpointWorkspace() {
    return this.workspaceStatus();
  }
  dispose() {
    this.overlays.clear();
    this.cache.clear();
    this.files.clear();
    this.contexts = [];
  }
}
