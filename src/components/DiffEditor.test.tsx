// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { GitDiff } from '../contracts';
import { DiffEditor } from './DiffEditor';

vi.mock('../editor/syntax', () => ({ syntaxFor: () => Promise.resolve([]) }));
const diff: GitDiff = {
  path: 'main.go',
  before: 'package main\nfunc a() {}\n',
  after: 'package main\nfunc b() {}\n',
  patch: '',
  binary: false,
  fingerprint: 'x',
  kind: 'text',
  partialAllowed: true,
  hunks: [],
};

afterEach(cleanup);
describe('DiffEditor', () => {
  it('shows HEAD and working tree side by side, then unified', async () => {
    const { container } = render(<DiffEditor diff={diff} dark />);
    await waitFor(() => expect(container.querySelectorAll('.cm-mergeViewEditor')).toHaveLength(2));
    expect(container.textContent).toContain('func a()');
    expect(container.textContent).toContain('func b()');
    fireEvent.click(screen.getByRole('button', { name: 'Unified' }));
    await waitFor(() => expect(container.querySelector('.cm-mergeView')).toBeNull());
    await waitFor(() => expect(container.querySelector('.cm-deletedChunk')).not.toBeNull());
  });
  it('explains binary files instead of rendering text', () => {
    render(<DiffEditor diff={{ ...diff, binary: true }} dark={false} />);
    expect(screen.getByText(/Binary file/)).toBeTruthy();
  });
});
