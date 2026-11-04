// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getChunks } from '@codemirror/merge';
import { undo } from '@codemirror/commands';
import { fireEvent, within } from '@testing-library/react';
import { CodeEditor } from './CodeEditor';
import { externalDocumentChange } from './external-change';
import { DocumentSession } from '../model/document-session';
import type { OpenEditor } from './editor-store';
import type { DocumentSnapshot } from '../contracts';

const initial: DocumentSnapshot = {
  path: '/project/readme.txt',
  content: 'original',
  revision: 1,
  workspaceGeneration: 1,
  dirty: false,
};
let container: HTMLDivElement;
let root: Root;
let doc: OpenEditor;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  // jsdom has no layout engine; geometry is intentionally outside these state tests.
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  const transport = {
    changeDocument: vi.fn(async (_path: string, revision: number) => ({
      ...initial,
      revision: revision + 1,
      dirty: true,
    })),
    saveDocument: vi.fn(async () => initial),
  };
  doc = {
    session: new DocumentSession(initial, transport, () => {}),
    state: null,
    initial: initial.content,
    views: new Set(),
    changeListeners: new Set(),
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function Editor({ diffBase, readOnly }: { diffBase?: string; readOnly?: boolean } = {}) {
  return (
    <CodeEditor
      document={doc}
      diffBase={diffBase}
      readOnly={readOnly}
      dark
      onNavigate={() => {}}
      onPosition={() => {}}
      onFocus={() => {}}
      onSave={() => {}}
    />
  );
}
describe('editor lifecycle', () => {
  it('blocks edits synchronously during an ownership transition without blocking external synchronization', async () => {
    await act(async () => root.render(<Editor />));
    const view = [...doc.views][0];
    // No React rerender: a pending keyboard/IME transaction must already be blocked.
    doc.editingLocked = true;
    await act(async () => view.dispatch({ changes: { from: 8, insert: 'lost edit' } }));
    expect(view.state.doc.toString()).toBe('original');
    expect(doc.session.dirty).toBe(false);
    await act(async () =>
      view.dispatch({
        changes: { from: 0, to: 8, insert: 'external' },
        annotations: externalDocumentChange.of(true),
      }),
    );
    expect(view.state.doc.toString()).toBe('external');
    doc.editingLocked = false;
    await act(async () => view.dispatch({ changes: { from: 8, insert: '!' } }));
    expect(view.state.doc.toString()).toBe('external!');
    await doc.session.flush();
    expect(doc.session.dirty).toBe(true);
  });
  it('retains text and undo history across closing and reopening a tab view', async () => {
    await act(async () => root.render(<Editor />));
    const view = [...doc.views][0];
    await act(async () => {
      view.dispatch({ changes: { from: 0, to: 8, insert: 'edited' } });
    });
    await doc.session.flush();
    await act(async () => root.render(null));
    expect(doc.state?.doc.toString()).toBe('edited');
    await act(async () => root.render(<Editor />));
    const reopened = [...doc.views][0];
    await act(async () => {
      undo(reopened);
    });
    expect(reopened.state.doc.toString()).toBe('original');
    await doc.session.flush();
  });
  it('does not retransmit changes loaded from disk', async () => {
    await act(async () => root.render(<Editor />));
    const view = [...doc.views][0];
    doc.session.acceptExternal({ ...initial, content: 'external', revision: 7 });
    await act(async () =>
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: 'external' },
        annotations: externalDocumentChange.of(true),
      }),
    );
    await doc.session.flush();
    expect(view.state.doc.toString()).toBe('external');
    expect(doc.session.revision).toBe(7);
    expect(doc.session.dirty).toBe(false);
  });
  it('synchronizes split editors through one change queue', async () => {
    await act(async () =>
      root.render(
        <>
          <Editor />
          <Editor />
        </>,
      ),
    );
    const [first, second] = [...doc.views];
    await act(async () => first.dispatch({ changes: { from: 8, insert: '!' } }));
    await doc.session.flush();
    expect(first.state.doc.toString()).toBe('original!');
    expect(second.state.doc.toString()).toBe('original!');
    expect(doc.session.revision).toBe(2);
  });
});

it('updates diff highlighting while editing and keeps normal undo history', async () => {
  await act(async () => root.render(<Editor diffBase="before" />));
  const view = [...doc.views][0];
  expect(getChunks(view.state)?.chunks).toHaveLength(1);
  await act(async () =>
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'before' } }),
  );
  expect(getChunks(view.state)?.chunks).toHaveLength(0);
  await act(async () => {
    undo(view);
  });
  expect(view.state.doc.toString()).toBe('original');
  expect(getChunks(view.state)?.chunks).toHaveLength(1);
  await act(async () => root.render(<Editor />));
  expect(getChunks(view.state)).toBeNull();
  expect(view.state.doc.toString()).toBe('original');
});

describe('find in the open file', () => {
  it('wraps to a match spanning the caret when a query is pasted', async () => {
    const { view, input, bar } = await openFind('hello');
    await act(async () => view.dispatch({ selection: { anchor: 2 } }));
    await act(async () => fireEvent.input(input, { target: { value: 'hello' } }));
    expect(view.state.selection.main.from).toBe(0);
    expect(view.state.selection.main.to).toBe(5);
    expect(within(bar).getByRole('status').textContent).toBe('1 of 1');
  });
  async function openFind(content = 'alpha Alpha alphabet\nalpha\n', readOnly = false) {
    doc.initial = content;
    await act(async () => root.render(<Editor readOnly={readOnly} />));
    const view = [...doc.views][0];
    await act(async () => {
      fireEvent.keyDown(view.contentDOM, { key: 'f', code: 'KeyF', ctrlKey: true });
    });
    const bar = within(container).getByRole('search', { name: 'Find in file' });
    const input = within(bar).getByRole('searchbox', { name: 'Find in file' });
    return { view, bar, input };
  }
  it('searches read-only files and updates counts when content changes externally', async () => {
    const { view, bar, input } = await openFind('foo', true);
    await act(async () => fireEvent.input(input, { target: { value: 'foo' } }));
    expect(within(bar).getByRole('status').textContent).toBe('1 of 1');
    await act(async () =>
      view.dispatch({
        changes: { from: 3, insert: ' foo' },
        annotations: externalDocumentChange.of(true),
      }),
    );
    expect(within(bar).getByRole('status').textContent).toBe('1 of 2');
    expect(doc.session.dirty).toBe(false);
  });
  it('labels capped match counts honestly on files with many matches', async () => {
    const { bar, input } = await openFind('x '.repeat(10_001));
    await act(async () => fireEvent.input(input, { target: { value: 'x' } }));
    expect(within(bar).getByRole('status').textContent).toBe('1 of 10,000+');
  });
  it('opens a focused search bar and navigates live matches with Enter and Shift+Enter', async () => {
    const { view, bar, input } = await openFind();
    expect(document.activeElement).toBe(input);
    await act(async () => fireEvent.input(input, { target: { value: 'alpha' } }));
    expect(within(bar).getByRole('status').textContent).toBe('1 of 4');
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      'alpha',
    );
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    expect(within(bar).getByRole('status').textContent).toBe('2 of 4');
    await act(async () => fireEvent.keyDown(input, { key: 'Enter', shiftKey: true }));
    expect(within(bar).getByRole('status').textContent).toBe('1 of 4');
    await act(async () =>
      fireEvent.click(within(bar).getByRole('button', { name: 'Previous match' })),
    );
    expect(within(bar).getByRole('status').textContent).toBe('4 of 4');
    expect(view.state.doc.toString()).toBe('alpha Alpha alphabet\nalpha\n');
  });
  it('supports case and whole-word options, invalid regex and no-results feedback', async () => {
    const { bar, input } = await openFind();
    await act(async () => fireEvent.input(input, { target: { value: 'alpha' } }));
    await act(async () => fireEvent.click(within(bar).getByRole('button', { name: 'Match case' })));
    expect(within(bar).getByRole('status').textContent).toBe('1 of 3');
    await act(async () => fireEvent.click(within(bar).getByRole('button', { name: 'Whole word' })));
    expect(within(bar).getByRole('status').textContent).toBe('1 of 2');
    await act(async () => fireEvent.input(input, { target: { value: 'missing' } }));
    expect(within(bar).getByRole('status').textContent).toBe('No results');
    expect(within(bar).getByRole('button', { name: 'Next match' }).hasAttribute('disabled')).toBe(
      true,
    );
    await act(async () =>
      fireEvent.click(within(bar).getByRole('button', { name: 'Regular expression' })),
    );
    await act(async () => fireEvent.input(input, { target: { value: '[' } }));
    expect(within(bar).getByRole('status').textContent).toBe('Invalid regular expression');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    await act(async () => fireEvent.input(input, { target: { value: 'alph[a-z]' } }));
    expect(within(bar).getByRole('status').textContent).toBe('1 of 2');
  });
  it('seeds from selected text, preserves the query across tabs, and closes back to the editor', async () => {
    doc.initial = 'foo foo';
    await act(async () => root.render(<Editor />));
    let view = [...doc.views][0];
    await act(async () => view.dispatch({ selection: { anchor: 0, head: 3 } }));
    await act(async () =>
      fireEvent.keyDown(view.contentDOM, { key: 'f', code: 'KeyF', ctrlKey: true }),
    );
    let input = within(container).getByRole('searchbox') as HTMLInputElement;
    expect(input.value).toBe('foo');
    await act(async () => root.render(null));
    await act(async () => root.render(<Editor />));
    view = [...doc.views][0];
    input = within(container).getByRole('searchbox') as HTMLInputElement;
    expect(input.value).toBe('foo');
    await act(async () => fireEvent.keyDown(input, { key: 'Escape' }));
    expect(within(container).queryByRole('search')).toBeNull();
    expect(document.activeElement).toBe(view.contentDOM);
  });
});
