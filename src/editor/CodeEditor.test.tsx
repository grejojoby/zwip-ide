// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { undo } from '@codemirror/commands';
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
function Editor() {
  return (
    <CodeEditor
      document={doc}
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
