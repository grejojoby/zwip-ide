// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { SqlConsole } from './SqlConsole';

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('executes only the selected SQL on Cmd+Enter and consumes the shortcut', () => {
  let read = () => '';
  const executed: string[] = [];
  render(
    <SqlConsole
      kind="postgres"
      tables={[]}
      columns={{}}
      initialContent={'SELECT 1;\nSELECT 2;'}
      onRead={(value) => {
        read = value;
      }}
      onExecute={() => executed.push(read())}
    />,
  );
  const editor = screen.getByRole('textbox', { name: 'SQL query' });
  const view = EditorView.findFromDOM(editor)!;
  act(() => view.dispatch({ selection: { anchor: 10, head: 19 } }));
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  fireEvent(editor, event);
  expect(executed).toEqual(['SELECT 2;']);
  expect(event.defaultPrevented).toBe(true);
  expect(view.state.doc.toString()).toBe('SELECT 1;\nSELECT 2;');
});
it('executes the whole console when nothing is selected', () => {
  let read = () => '';
  const executed: string[] = [];
  render(
    <SqlConsole
      kind="postgres"
      tables={[]}
      columns={{}}
      initialContent="SELECT 1;"
      onRead={(value) => {
        read = value;
      }}
      onExecute={() => executed.push(read())}
    />,
  );
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'SQL query' }), {
    key: 'Enter',
    code: 'Enter',
    metaKey: true,
  });
  expect(executed).toEqual(['SELECT 1;']);
});
