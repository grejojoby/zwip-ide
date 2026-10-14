// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { goSyntax } from './go-syntax';
import { blameGutter, setBlame } from './blame-gutter';
import { stickyScopeLines } from './sticky-lines';

let view: EditorView | undefined;
afterEach(() => view?.destroy());

it('shows blame beside committed lines and keeps it on its line through edits', () => {
  view = new EditorView({
    state: EditorState.create({ doc: 'one\ntwo\nthree', extensions: [blameGutter()] }),
    parent: document.body,
  });
  view.dispatch({
    effects: setBlame.of([
      {
        line: 2,
        commit: 'a'.repeat(40),
        author: 'sahil',
        authorTime: 1_760_000_000,
        summary: 'Fix',
      },
      { line: 3, commit: '0'.repeat(40), author: 'Not Committed Yet', authorTime: 0, summary: '' },
    ]),
  });
  view.dispatch({ changes: { from: 0, insert: 'zero\n' } });
  const labels = [...view.dom.querySelectorAll('.cm-blame-gutter .cm-gutterElement span')];
  expect(labels.map((label) => label.textContent)).toEqual([expect.stringContaining('sahil')]);
  expect(labels[0].getAttribute('title')).toContain('Fix');
  view.dispatch({ effects: setBlame.of(null) });
  expect(view.dom.querySelectorAll('.cm-blame-gutter .cm-gutterElement span')).toHaveLength(0);
});

it('finds the enclosing Go function header once it scrolls past the top', () => {
  const doc = ['package main', 'func long() {', '\ta := 1', '\tb := 2', '\t_ = a + b', '}'].join(
    '\n',
  );
  view = new EditorView({
    state: EditorState.create({ doc, extensions: [goSyntax()] }),
    parent: document.body,
  });
  const at = (line: number) =>
    (view!.lineBlockAtHeight = () => view!.lineBlockAt(view!.state.doc.line(line).from));
  at(4);
  expect(stickyScopeLines(view)).toEqual([2]);
  at(2);
  expect(stickyScopeLines(view)).toEqual([]);
});
