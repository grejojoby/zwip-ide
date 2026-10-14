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
  it('does not mark directories selected when no file is active', () => {
    render(<ProjectTree root="/project" files={files} onOpen={() => {}} />);
    expect(screen.getByRole('treeitem', { name: 'src' }).getAttribute('aria-selected')).toBe(
      'false',
    );
  });
});
describe('excluding directories from the project tree', () => {
  it('offers exclusion for folders only', () => {
    const onExclude = vi.fn();
    render(<ProjectTree root="/project" files={files} onOpen={() => {}} onExclude={onExclude} />);
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: 'src' }));
    const item = screen.getByRole('menuitemcheckbox', { name: 'Exclude from search and indexing' });
    expect(item.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(item);
    expect(onExclude).toHaveBeenCalledWith('src', true);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(screen.getByRole('treeitem', { name: 'src' }));
    fireEvent.click(screen.getByRole('treeitem', { name: 'deep' }));
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: 'first.ts' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });
  it('shows excluded folders dimmed with a tick, and unticking includes them again', () => {
    const onExclude = vi.fn();
    render(
      <ProjectTree
        root="/project"
        files={files}
        excludedDirectories={[
          { path: 'vendor', reason: 'Excluded by you' },
          { path: 'node_modules', reason: 'Dependency or build directory' },
        ]}
        onOpen={() => {}}
        onExclude={onExclude}
      />,
    );
    const vendor = screen.getByRole('treeitem', { name: 'vendor' });
    expect(vendor.className).toContain('excluded');
    fireEvent.contextMenu(vendor);
    const item = screen.getByRole('menuitemcheckbox', { name: 'Exclude from search and indexing' });
    expect(item.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(item);
    expect(onExclude).toHaveBeenCalledWith('vendor', false);
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: 'node_modules' }));
    const fixed = screen.getByRole('menuitemcheckbox', {
      name: 'Exclude from search and indexing',
    });
    expect(fixed.getAttribute('aria-checked')).toBe('true');
    expect((fixed as HTMLButtonElement).disabled).toBe(true);
  });
});
describe('git-ignored entries in the project tree', () => {
  it('lists ignored folders and files with the ignored style', () => {
    const onOpen = vi.fn();
    render(
      <ProjectTree
        root="/project"
        files={files}
        ignoredDirectories={['/project/.idea']}
        ignoredFiles={[
          { path: '/project/.idea/workspace.xml', relativePath: '.idea/workspace.xml', size: 1 },
        ]}
        onOpen={onOpen}
      />,
    );
    const idea = screen.getByRole('treeitem', { name: '.idea' });
    expect(idea.className).toContain('ignored');
    fireEvent.click(idea);
    const file = screen.getByRole('treeitem', { name: 'workspace.xml' });
    expect(file.className).toContain('ignored');
    fireEvent.click(file);
    expect(onOpen).toHaveBeenCalledWith('/project/.idea/workspace.xml');
  });
});
