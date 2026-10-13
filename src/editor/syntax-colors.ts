import type { Extension } from '@codemirror/state';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

/** Shared, theme-aware colors for source editors and tool consoles. */
export function syntaxColors(dark: boolean): Extension {
  return syntaxHighlighting(
    HighlightStyle.define([
      {
        tag: [tags.keyword, tags.modifier, tags.operatorKeyword],
        color: dark ? '#dca475' : '#8b3990',
      },
      { tag: [tags.string, tags.regexp], color: dark ? '#91c48b' : '#266832' },
      { tag: [tags.number, tags.bool, tags.null], color: dark ? '#86b5df' : '#225ea8' },
      { tag: [tags.typeName, tags.className, tags.namespace], color: dark ? '#d3bd83' : '#775200' },
      { tag: tags.function(tags.variableName), color: dark ? '#8fb7ee' : '#2158a5' },
      {
        tag: [tags.comment, tags.docComment],
        color: dark ? '#9ba1ab' : '#646c78',
        fontStyle: 'italic',
      },
      { tag: [tags.propertyName, tags.attributeName], color: dark ? '#c8c2e8' : '#6d4797' },
      { tag: tags.invalid, color: dark ? '#f09e9e' : '#b83434' },
    ]),
  );
}
