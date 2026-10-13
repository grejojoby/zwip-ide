import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { navigationHighlight, showNavigationTarget } from './navigation-highlight';

const count = (state: EditorState) => state.field(navigationHighlight).size;

describe('navigation highlight', () => {
  it('marks the target line and symbol until the user moves the cursor', () => {
    let state = EditorState.create({
      doc: 'one\nfunc Run() {}\n',
      extensions: [navigationHighlight],
    });
    state = state.update({
      selection: { anchor: 9 },
      effects: showNavigationTarget.of({ from: 9, to: 12 }),
    }).state;
    expect(count(state)).toBe(2);
    state = state.update({ selection: { anchor: 2 }, userEvent: 'select' }).state;
    expect(count(state)).toBe(0);
  });
  it('clears on edits', () => {
    let state = EditorState.create({ doc: 'abc', extensions: [navigationHighlight] });
    state = state.update({ effects: showNavigationTarget.of({ from: 0, to: 0 }) }).state;
    expect(count(state)).toBe(1);
    state = state.update({ changes: { from: 0, insert: 'x' } }).state;
    expect(count(state)).toBe(0);
  });
});
