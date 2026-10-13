import { useEffect, useState, type ReactNode } from 'react';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { highlightTree } from '@lezer/highlight';
import { codeHighlighter } from './syntax-colors';
import { syntaxFor } from './syntax';

export interface Token {
  text: string;
  className?: string;
}

/** Highlights `text` with the grammar the editor uses for `path`, split into lines. */
export async function highlightLines(path: string, text: string): Promise<Token[][]> {
  const state = EditorState.create({ doc: text, extensions: [await syntaxFor(path)] });
  const tree = ensureSyntaxTree(state, text.length, 2000) ?? syntaxTree(state);
  const lines: Token[][] = [[]];
  const push = (from: number, to: number, className?: string) => {
    text
      .slice(from, to)
      .split('\n')
      .forEach((part, index) => {
        if (index > 0) lines.push([]);
        if (part)
          lines[lines.length - 1].push(className ? { text: part, className } : { text: part });
      });
  };
  let at = 0;
  highlightTree(tree, codeHighlighter, (from, to, className) => {
    push(at, from);
    push(from, to, className);
    at = to;
  });
  push(at, text.length);
  return lines;
}

/** Highlighted lines of `text`, or null until highlighting finishes or if it fails. */
export function useHighlightedLines(path: string, text: string | null): Token[][] | null {
  const [result, setResult] = useState<{ key: string; lines: Token[][] } | null>(null);
  const key = `${path}\n${text}`;
  useEffect(() => {
    if (text === null) return;
    let active = true;
    highlightLines(path, text)
      .then((lines) => active && setResult({ key, lines }))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [key]);
  return result?.key === key ? result.lines : null;
}

/** Renders tokens, wrapping the character ranges in `marks` (sorted, non-overlapping). */
export function renderTokens(tokens: Token[], marks: [number, number][] = [], markClass = '') {
  const parts: ReactNode[] = [];
  let offset = 0;
  tokens.forEach((token, index) => {
    const end = offset + token.text.length;
    const cuts = new Set([offset, end]);
    for (const [from, to] of marks) {
      if (from > offset && from < end) cuts.add(from);
      if (to > offset && to < end) cuts.add(to);
    }
    const points = [...cuts].sort((a, b) => a - b);
    for (let at = 0; at < points.length - 1; at += 1) {
      const [from, to] = [points[at], points[at + 1]];
      const text = token.text.slice(from - offset, to - offset);
      const marked = marks.some(([start, stop]) => from >= start && to <= stop);
      parts.push(
        <span
          key={`${index}:${from}`}
          className={[token.className, marked && markClass].filter(Boolean).join(' ') || undefined}
        >
          {text}
        </span>,
      );
    }
    offset = end;
  });
  return parts;
}

/** One line of source, colored like the editor. Plain text shows until highlighting is ready. */
export function CodePreview({ path, text }: { path: string; text: string }) {
  const lines = useHighlightedLines(path, text);
  return <code className="code-preview">{lines ? renderTokens(lines[0] ?? []) : text}</code>;
}
