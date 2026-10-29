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
  it('reveals the active file once, not again when another folder is expanded', () => {
    const many = [
      ...Array.from({ length: 60 }, (_, index) => `a/file${index}.ts`),
      'b/other.ts',
      'z/target.ts',
    ].map((relativePath) => ({ path: `/project/${relativePath}`, relativePath, size: 1 }));
    const view = render(
      <ProjectTree root="/project" files={many} active="/project/z/target.ts" onOpen={() => {}} />,
    );
    const tree = screen.getByRole('tree');
    // Expanding "a" pushes the active file far below the viewport; the tree must stay put.
    fireEvent.click(screen.getByRole('treeitem', { name: 'a' }));
    expect(tree.scrollTop).toBe(0);
    // Opening another file still reveals it.
    view.rerender(
      <ProjectTree root="/project" files={many} active="/project/a/file59.ts" onOpen={() => {}} />,
    );
    expect(tree.scrollTop).toBeGreaterThan(0);
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
    // WebKit: a mousedown must not move focus, or the menu closes before the click.
    fireEvent.mouseDown(item);
    expect(screen.getByRole('menu')).toBeTruthy();
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

describe('file context actions', () => {
  it('targets the clicked file without opening it and supports keyboard invocation', () => {
    const onOpen = vi.fn();
    const onAction = vi.fn();
    render(
      <ProjectTree
        root="/project"
        files={files}
        active={files[0].path}
        onOpen={onOpen}
        onAction={onAction}
      />,
    );
    const second = screen.getByRole('treeitem', { name: 'second.ts' });
    fireEvent.contextMenu(second);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename or move…' }));
    expect(onAction).toHaveBeenCalledWith('rename', files[1].path, false);
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.keyDown(second, { key: 'F10', shiftKey: true });
    expect(screen.getByRole('menuitem', { name: 'Copy file…' })).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(second);
  });
  it('creates inside a selected directory and omits file-only actions', () => {
    const onAction = vi.fn();
    render(<ProjectTree root="/project" files={files} onOpen={vi.fn()} onAction={onAction} />);
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: 'src' }));
    expect(screen.queryByRole('menuitem', { name: 'Delete…' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'New file…' }));
    expect(onAction).toHaveBeenCalledWith('file', '/project/src', true);
  });
});

it('offers Find in folder for directories using pointer and keyboard menus', () => {
  const onAction = vi.fn();
  render(
    <ProjectTree
      root="/project"
      files={files}
      active={files[0].path}
      onOpen={vi.fn()}
      onAction={onAction}
    />,
  );
  fireEvent.contextMenu(screen.getByRole('treeitem', { name: 'src' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Find in folder…' }));
  expect(onAction).toHaveBeenLastCalledWith('search', '/project/src', true);
  fireEvent.keyDown(screen.getByRole('treeitem', { name: 'deep' }), { key: 'F10', shiftKey: true });
  fireEvent.click(screen.getByRole('menuitem', { name: 'Find in folder…' }));
  expect(onAction).toHaveBeenLastCalledWith('search', '/project/src/deep', true);
  fireEvent.contextMenu(screen.getByRole('treeitem', { name: 'first.ts' }));
  expect(screen.queryByRole('menuitem', { name: 'Find in folder…' })).toBeNull();
});
