import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getLanguageService as createHtmlService } from 'vscode-html-languageservice';
import { getCSSLanguageService as createCssService } from 'vscode-css-languageservice';
import type { CompletionList, Hover, TextEdit, WorkspaceEdit } from 'vscode-css-languageservice';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type {
  EditorRequest,
  EditorResult,
  NavigationBatch,
  NavigationQuery,
  SemanticEdit,
  SourceLocation,
  SourceRange,
} from '../../../src/contracts';

let html: ReturnType<typeof createHtmlService> | undefined;
let css: ReturnType<typeof createCssService> | undefined;
export const isMarkup = (path: string) => /\.(?:html?|css)$/i.test(path);
const isCss = (path: string) => /\.css$/i.test(path);
const htmlService = () => (html ??= createHtmlService());
const cssService = () => (css ??= createCssService());
const document = (path: string, content: string, revision: number) =>
  TextDocument.create(pathToFileURL(path).href, isCss(path) ? 'css' : 'html', revision, content);
const hoverText = (hover: Hover | null) =>
  !hover
    ? ''
    : (Array.isArray(hover.contents) ? hover.contents : [hover.contents])
        .map((item) => (typeof item === 'string' ? item : item.value))
        .join('\n\n')
        .replace(/!\[[^\]]*\]\(data:[^)]*\)/g, '');

function edits(doc: TextDocument, changes: TextEdit[]): SemanticEdit[] {
  return changes.map((change) => ({
    path: fileURLToPath(doc.uri),
    revision: doc.version,
    fileHash: createHash('sha256').update(doc.getText()).digest('hex'),
    range: change.range,
    newText: change.newText,
  }));
}
function workspaceEdits(doc: TextDocument, changes: WorkspaceEdit): SemanticEdit[] {
  if (
    changes.documentChanges?.length ||
    Object.keys(changes.changes ?? {}).some((uri) => uri !== doc.uri)
  )
    throw new Error('Markup action requires unsupported cross-file or resource edits.');
  return edits(doc, changes.changes?.[doc.uri] ?? []);
}
function completions(list: CompletionList, doc: TextDocument) {
  return list.items
    .filter((item) => !item.command || item.command.command === 'editor.action.triggerSuggest')
    .map((item) => {
      const change = item.textEdit && 'range' in item.textEdit ? item.textEdit : undefined;
      let insertText = change?.newText ?? item.insertText ?? item.label;
      // The renderer currently accepts plain text. Expand simple default placeholders.
      if (item.insertTextFormat === 2)
        insertText = insertText
          .replace(/\$\{\d+:([^{}]*)\}/g, '$1')
          .replace(/\$\{\d+\|([^,|]*)(?:,[^|]*)?\|\}/g, '$1')
          .replace(/\$(?:\d+|\{\d+\})/g, '');
      return {
        label: item.label,
        detail: item.detail,
        insertText,
        range: change?.range,
        additionalEdits: item.additionalTextEdits
          ? edits(doc, item.additionalTextEdits)
          : undefined,
      };
    });
}
function location(
  path: string,
  content: string,
  range: SourceRange,
  name: string,
  relationship: string,
  contextIds: string[],
): SourceLocation {
  return {
    path,
    range,
    name,
    relationship,
    contextIds,
    preview: content.split(/\r?\n/)[range.start.line]?.trim() ?? '',
  };
}

export function markupEditor(
  request: EditorRequest,
  content: string,
  contextIds: string[],
): EditorResult {
  const result: EditorResult = {
    id: request.id,
    documentRevision: request.documentRevision,
    workspaceGeneration: request.workspaceGeneration,
    state: 'complete',
    reasons: [],
  };
  const doc = document(request.path, content, request.documentRevision);
  const position = request.position ?? { line: 0, character: 0 };
  const unsupported = (reason: string): EditorResult => ({
    ...result,
    state: 'unsupported',
    reasons: [reason],
  });
  if (isCss(request.path)) {
    const service = cssService();
    const stylesheet = service.parseStylesheet(doc);
    switch (request.operation) {
      case 'completion':
        result.completions = completions(service.doComplete(doc, position, stylesheet), doc);
        break;
      case 'hover':
        result.hover = hoverText(service.doHover(doc, position, stylesheet));
        break;
      case 'diagnostics':
        result.diagnostics = service.doValidation(doc, stylesheet).map((item) => ({
          range: item.range,
          severity: item.severity === 1 ? 'error' : item.severity === 2 ? 'warning' : 'information',
          message: item.message,
          source: 'CSS',
        }));
        break;
      case 'format':
        result.edits = edits(
          doc,
          service.format(doc, request.range, { tabSize: 2, insertSpaces: true }),
        );
        break;
      case 'symbols':
        result.symbols = service
          .findDocumentSymbols(doc, stylesheet)
          .map((item) =>
            location(request.path, content, item.location.range, item.name, 'symbol', contextIds),
          );
        break;
      case 'codeActions': {
        const range = request.range ?? { start: position, end: position };
        result.codeActions = service
          .doCodeActions2(
            doc,
            range,
            { diagnostics: service.doValidation(doc, stylesheet) },
            stylesheet,
          )
          .filter((action) => action.edit && !action.command)
          .map((action) => ({
            title: action.title,
            kind: action.kind,
            edits: workspaceEdits(doc, action.edit!),
          }));
        break;
      }
      case 'rename':
        return unsupported(
          'CSS rename across stylesheets and HTML class usages is not available; a file-local rename could leave usages behind.',
        );
      default:
        return unsupported(`Unsupported CSS editor operation: ${request.operation}`);
    }
  } else {
    const service = htmlService();
    const htmlDocument = service.parseHTMLDocument(doc);
    switch (request.operation) {
      case 'completion':
        result.completions = completions(service.doComplete(doc, position, htmlDocument), doc);
        break;
      case 'hover':
        result.hover = hoverText(service.doHover(doc, position, htmlDocument));
        break;
      case 'format':
        result.edits = edits(
          doc,
          service.format(doc, request.range, { tabSize: 2, insertSpaces: true }),
        );
        break;
      case 'symbols':
        result.symbols = service
          .findDocumentSymbols(doc, htmlDocument)
          .map((item) =>
            location(request.path, content, item.location.range, item.name, 'symbol', contextIds),
          );
        break;
      case 'rename': {
        if (!request.newName || !/^[A-Za-z][\w:-]*$/.test(request.newName))
          throw new Error('HTML tag names must be valid non-empty names.');
        if (!service.findLinkedEditingRanges(doc, position, htmlDocument)?.length)
          return unsupported(
            'HTML rename supports matching start and end tags; cross-file class and ID rename is unavailable.',
          );
        const change = service.doRename(doc, position, request.newName, htmlDocument);
        result.edits = change ? workspaceEdits(doc, change) : [];
        result.reasons.push(
          'This rename updates the matching tag pair in the current HTML document.',
        );
        break;
      }
      case 'diagnostics':
        return unsupported(
          'The installed HTML service does not provide HTML validation; embedded script/style diagnostics are not yet connected.',
        );
      case 'codeActions':
        return unsupported('HTML code actions are not available in the installed service.');
      default:
        return unsupported(`Unsupported HTML editor operation: ${request.operation}`);
    }
  }
  if (request.operation === 'symbols' && request.query) {
    result.symbols = result.symbols?.filter((item) =>
      item.name.toLowerCase().includes(request.query!.toLowerCase()),
    );
    result.state = 'partial';
    result.reasons.push('Markup symbol search currently covers this document only.');
  }
  return result;
}

export function markupNavigation(
  query: NavigationQuery,
  content: string,
  contextIds: string[],
): NavigationBatch {
  const result: NavigationBatch = {
    id: query.id,
    documentRevision: query.documentRevision,
    workspaceGeneration: query.workspaceGeneration,
    state: 'partial',
    reasons: [
      'Markup navigation currently covers the current document only; cross-file stylesheet imports and HTML class links are not indexed.',
    ],
    locations: [],
    searchedContexts: 1,
    totalContexts: Math.max(1, contextIds.length),
  };
  const doc = document(query.path, content, query.documentRevision);
  if (isCss(query.path) && ['definition', 'references'].includes(query.operation)) {
    const service = cssService();
    const stylesheet = service.parseStylesheet(doc);
    const found =
      query.operation === 'references'
        ? service.findReferences(doc, query.position, stylesheet)
        : [service.findDefinition(doc, query.position, stylesheet)].filter((item) => item !== null);
    result.locations = found.map((item) =>
      location(
        fileURLToPath(item.uri),
        content,
        item.range,
        doc.getText(item.range),
        query.operation,
        contextIds,
      ),
    );
  } else if (!isCss(query.path) && query.operation === 'references') {
    const service = htmlService();
    result.locations = service
      .findDocumentHighlights(doc, query.position, service.parseHTMLDocument(doc))
      .map((item) =>
        location(query.path, content, item.range, doc.getText(item.range), 'reference', contextIds),
      );
  } else {
    result.state = 'unsupported';
    result.reasons = [`${query.operation} is not available for this markup language.`];
    result.searchedContexts = 0;
  }
  return result;
}
