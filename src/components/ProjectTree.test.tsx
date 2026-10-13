// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ProjectTree } from './ProjectTree';
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const files = ['src/deep/first.ts', 'src/deep/second.ts'].map((relativePath) => ({
  path: `/project/${relativePath}`,
  relativePath,
  size: 1,
}));
describe('active source in project tree', () => {
  it('reveals a newly active nested file without stealing editor focus', () => {
    const editor = document.createElement('textarea');
    document.body.append(editor);
    editor.focus();
    const view = render(<ProjectTree root="/project" files={files} onOpen={() => {}} />);
    expect(screen.queryByRole('treeitem', { name: 'first.ts' })).toBeNull();
    view.rerender(
      <ProjectTree root="/project" files={files} active={files[0].path} onOpen={() => {}} />,
    );
    expect(screen.getByRole('treeitem', { name: 'first.ts' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(document.activeElement).toBe(editor);
    editor.remove();
  });
  it('respects a manual collapse until navigation selects another file', () => {
    const view = render(
      <ProjectTree root="/project" files={files} active={files[0].path} onOpen={() => {}} />,
    );
    fireEvent.click(screen.getByRole('treeitem', { name: 'src' }));
    expect(screen.queryByRole('treeitem', { name: 'first.ts' })).toBeNull();
    view.rerender(
      <ProjectTree root="/project" files={files} active={files[1].path} onOpen={() => {}} />,
    );
    expect(screen.getByRole('treeitem', { name: 'second.ts' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });
});
