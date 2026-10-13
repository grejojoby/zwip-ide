import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { breakpointField, setBreakpoints } from './debug-gutters';
describe('breakpoint mapping', () => {
  it('moves a breakpoint with its source line when text is inserted before it', () => {
    let state = EditorState.create({ doc: 'one\ntwo\nthree', extensions: [breakpointField] });
    state = state.update({ effects: setBreakpoints.of([1]) }).state;
    state = state.update({ changes: { from: 0, insert: 'new\n' } }).state;
    const cursor = state.field(breakpointField).iter();
    expect(state.doc.lineAt(cursor.from).number).toBe(3);
    expect(cursor.value).toBeTruthy();
  });
});
