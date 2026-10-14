import { LanguageSupport, syntaxTree } from '@codemirror/language';
import { goLanguage } from '@codemirror/lang-go';
import { RangeSetBuilder, type EditorState } from '@codemirror/state';
import {
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from '@codemirror/view';
import type { SyntaxNode, Tree } from '@lezer/common';
import { styleTags, tags } from '@lezer/highlight';

// Kept self-contained: the Go package bundles this file as its downloadable grammar.

const predeclaredTypes = new Set([
  'any',
  'bool',
  'byte',
  'comparable',
  'complex64',
  'complex128',
  'error',
  'float32',
  'float64',
  'int',
  'int8',
  'int16',
  'int32',
  'int64',
  'rune',
  'string',
  'uint',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
  'uintptr',
]);

/** Name an import path is referenced by: `gopkg.in/yaml.v3` → yaml, `x/go-redis/v8` → redis. */
function importedName(path: string): string {
  const segments = path.split('/');
  let name = segments.pop() ?? '';
  if (/^v\d+$/.test(name) && segments.length) name = segments.pop() ?? '';
  return name
    .replace(/\.v\d+$/, '')
    .replace(/^go-/, '')
    .replace(/[.-]go$/, '');
}

/** Package names the file's imports bring into scope (blank and dot imports bind none). */
export function goImportNames(state: EditorState, tree: Tree = syntaxTree(state)): Set<string> {
  const names = new Set<string>();
  for (let decl = tree.topNode.firstChild; decl; decl = decl.nextSibling) {
    if (decl.name !== 'ImportDecl') continue;
    for (const spec of [
      ...decl.getChildren('ImportSpec'),
      ...(decl.getChild('SpecList')?.getChildren('ImportSpec') ?? []),
    ]) {
      const alias = spec.getChild('DefName');
      const path = spec.getChild('String');
      if (alias) names.add(state.sliceDoc(alias.from, alias.to));
      else if (path) names.add(importedName(state.sliceDoc(path.from + 1, path.to - 1)));
    }
  }
  names.delete('_');
  names.delete('.');
  return names;
}

function receiverName(node: SyntaxNode, state: EditorState): string | null {
  for (let at = node.parent; at; at = at.parent) {
    if (at.name !== 'MethodDecl') continue;
    const name = at.getChild('Parameters')?.getChild('Parameter')?.getChild('DefName');
    return name ? state.sliceDoc(name.from, name.to) : null;
  }
  return null;
}

export interface GoToken {
  from: number;
  to: number;
  className: string;
}

/**
 * GoLand roles that depend on identifier text rather than grammar position: package
 * qualifiers, predeclared types, the method receiver and struct-tag keys. Shadowing by
 * local declarations is not tracked.
 */
export function goSemanticTokens(
  state: EditorState,
  from = 0,
  to = state.doc.length,
  tree: Tree = syntaxTree(state),
): GoToken[] {
  const imports = goImportNames(state, tree);
  const tokens: GoToken[] = [];
  const add = (start: number, end: number, className: string) => {
    if (start < end) tokens.push({ from: start, to: end, className });
  };
  tree.iterate({
    from,
    to,
    enter: (ref) => {
      const text = () => state.sliceDoc(ref.from, ref.to);
      const parent = ref.node.parent;
      if (ref.name === 'TypeName' && predeclaredTypes.has(text())) {
        add(ref.from, ref.to, 'tok-builtin');
      } else if (ref.name === 'VariableName') {
        const name = text();
        const receiver = receiverName(ref.node, state);
        if (name === receiver) add(ref.from, ref.to, 'tok-receiver');
        // Package-qualified types are tagged by the grammar; selectors need the import list.
        else if (imports.has(name) && parent?.name === 'SelectorExpr' && !ref.node.prevSibling)
          add(ref.from, ref.to, 'tok-package');
        else if (parent?.name === 'CallExpr' && predeclaredTypes.has(name))
          add(ref.from, ref.to, 'tok-builtin');
      } else if (
        ref.name === 'DefName' &&
        parent?.name === 'Parameter' &&
        parent.parent?.name === 'Parameters' &&
        parent.parent.parent?.name === 'MethodDecl' &&
        parent.parent.prevSibling?.name === 'func'
      ) {
        add(ref.from, ref.to, 'tok-receiver');
      } else if (ref.name === 'String' && parent?.name === 'FieldDecl' && text()[0] === '`') {
        // Struct tags: keys and delimiters read as text, quoted values stay strings.
        const value = /"(?:[^"\\]|\\.)*"/g;
        let at = ref.from;
        for (const match of text().matchAll(value)) {
          add(at, ref.from + match.index, 'tok-struct-tag');
          at = ref.from + match.index + match[0].length;
        }
        add(at, ref.to, 'tok-struct-tag');
      }
    },
  });
  return tokens;
}

const marks = new Map<string, Decoration>();
function decorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);
  for (const range of view.visibleRanges)
    for (const token of goSemanticTokens(view.state, range.from, range.to, tree)) {
      let mark = marks.get(token.className);
      if (!mark) marks.set(token.className, (mark = Decoration.mark({ class: token.className })));
      builder.add(token.from, token.to, mark);
    }
  return builder.finish();
}

const goSemanticHighlighting = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = decorations(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      )
        this.decorations = decorations(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** Go grammar with GoLand-style roles for packages, types, methods, calls and constants. */
export function goSyntax(): LanguageSupport {
  const language = goLanguage.configure({
    props: [
      styleTags({
        'MethodDecl/FieldName MethodElem/FieldName': tags.function(
          tags.definition(tags.propertyName),
        ),
        'CallExpr/SelectorExpr/FieldName': tags.function(tags.propertyName),
        'ConstSpec/DefName': tags.constant(tags.variableName),
        'PackageClause/DefName ImportSpec/DefName QualifiedType/VariableName': tags.namespace,
        // GoLand shows struct fields as plain text.
        FieldName: tags.content,
      }),
    ],
  });
  // `semanticTokens` lets read-only previews apply the same roles without an editor view.
  return new LanguageSupport(language, [
    goSemanticHighlighting,
    language.data.of({ semanticTokens: goSemanticTokens }),
  ]);
}
