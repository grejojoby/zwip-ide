import type { Extension } from '@codemirror/state';
import { syntaxHighlighting } from '@codemirror/language';
import { tagHighlighter, tags } from '@lezer/highlight';

/**
 * Token classes shared by editors, consoles and read-only code previews. The colors live in
 * styles.css (`--syntax-*`) and follow IntelliJ's Dark and Light color schemes.
 */
export const codeHighlighter = tagHighlighter([
  {
    tag: [tags.keyword, tags.modifier, tags.self, tags.bool, tags.null, tags.atom, tags.escape],
    class: 'tok-keyword',
  },
  {
    tag: [tags.string, tags.character, tags.special(tags.string), tags.regexp],
    class: 'tok-string',
  },
  { tag: tags.attributeValue, class: 'tok-string' },
  { tag: [tags.number, tags.integer, tags.float], class: 'tok-number' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], class: 'tok-comment' },
  { tag: tags.docComment, class: 'tok-doc-comment' },
  {
    tag: [
      tags.function(tags.definition(tags.variableName)),
      tags.function(tags.definition(tags.propertyName)),
    ],
    class: 'tok-function-declaration',
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    class: 'tok-function-call',
  },
  { tag: [tags.propertyName, tags.definition(tags.propertyName)], class: 'tok-field' },
  {
    tag: [tags.constant(tags.variableName), tags.standard(tags.variableName)],
    class: 'tok-constant',
  },
  { tag: [tags.typeName, tags.className], class: 'tok-type' },
  { tag: tags.namespace, class: 'tok-package' },
  { tag: [tags.annotation, tags.meta], class: 'tok-annotation' },
  { tag: tags.tagName, class: 'tok-tag' },
  { tag: tags.attributeName, class: 'tok-attribute' },
  { tag: tags.heading, class: 'tok-heading' },
  { tag: tags.emphasis, class: 'tok-emphasis' },
  { tag: tags.strong, class: 'tok-strong' },
  { tag: [tags.link, tags.url], class: 'tok-link' },
  { tag: tags.invalid, class: 'tok-invalid' },
]);

export function syntaxColors(): Extension {
  return syntaxHighlighting(codeHighlighter);
}
