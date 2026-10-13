// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { EditorState } from '@codemirror/state';
import { MarkdownPreview } from './MarkdownPreview';
import { DocumentSession } from '../model/document-session';
import type { OpenEditor } from '../editor/editor-store';

afterEach(cleanup);

describe('MarkdownPreview', () => {
  it('re-renders from the live editor text after edits', async () => {
    const snapshot = {
      path: '/p/README.md',
      content: '# One',
      revision: 1,
      workspaceGeneration: 1,
      dirty: false,
    };
    const document: OpenEditor = {
      session: new DocumentSession(snapshot, {} as never, () => {}),
      state: null,
      initial: snapshot.content,
      views: new Set(),
      changeListeners: new Set(),
    };
    render(<MarkdownPreview document={document} />);
    expect(screen.getByRole('heading', { name: 'One' })).toBeTruthy();
    document.state = EditorState.create({ doc: '# Two' });
    act(() => document.changeListeners.forEach((listener) => listener()));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Two' })).toBeTruthy());
  });
});
