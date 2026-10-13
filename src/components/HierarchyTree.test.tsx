// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HierarchyTree } from './HierarchyTree';
import type { NavigationBatch, SourceLocation } from '../contracts';
afterEach(cleanup);
const root: SourceLocation = {
  path: '/p/main.go',
  name: 'main',
  preview: 'func main()',
  range: { start: { line: 0, character: 5 }, end: { line: 0, character: 9 } },
  relationship: 'caller',
  contextIds: ['m'],
};
const result = (locations: SourceLocation[]): NavigationBatch => ({
  id: 'q',
  documentRevision: 1,
  workspaceGeneration: 1,
  state: 'complete',
  locations,
  searchedContexts: 1,
  totalContexts: 1,
  reasons: [],
});
describe('hierarchy navigation', () => {
  it('adds streamed roots without discarding an already expanded relation', async () => {
    const child = { ...root, name: 'child', path: '/p/child.go' };
    const later = { ...root, name: 'later', path: '/p/later.go' };
    const props = {
      operation: 'incomingCalls' as const,
      title: 'Incoming calls',
      onExpand: async () => result([child]),
      onOpen: vi.fn(),
      onCancel: vi.fn(),
    };
    const view = render(
      <HierarchyTree {...props} batch={{ ...result([]), state: 'loading' }} loading />,
    );
    expect(screen.queryAllByRole('treeitem')).toHaveLength(0);
    view.rerender(
      <HierarchyTree {...props} batch={{ ...result([root]), state: 'loading' }} loading />,
    );
    await waitFor(() => expect(screen.getAllByRole('treeitem')).toHaveLength(1));
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getAllByRole('treeitem')).toHaveLength(2));
    view.rerender(<HierarchyTree {...props} batch={result([root, later])} loading={false} />);
    await waitFor(() => expect(screen.getAllByRole('treeitem')).toHaveLength(3));
    expect(screen.getByRole('button', { name: 'Collapse main' })).toBeTruthy();
  });
  it('expands direct relations with ArrowRight, opens children, and collapses with ArrowLeft', async () => {
    const child = { ...root, name: 'child', path: '/p/child.go' };
    const expand = vi.fn(async () => result([child]));
    const open = vi.fn();
    render(
      <HierarchyTree
        batch={result([root])}
        operation="outgoingCalls"
        title="Outgoing calls"
        loading={false}
        onExpand={expand}
        onOpen={open}
        onCancel={() => {}}
      />,
    );
    const tree = screen.getByRole('tree');
    fireEvent.keyDown(tree, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getAllByRole('treeitem')).toHaveLength(2));
    fireEvent.keyDown(tree, { key: 'ArrowRight' });
    fireEvent.keyDown(tree, { key: 'Enter' });
    expect(open).toHaveBeenCalledWith(child);
    fireEvent.keyDown(tree, { key: 'ArrowLeft' });
    fireEvent.keyDown(tree, { key: 'ArrowLeft' });
    expect(screen.getAllByRole('treeitem')).toHaveLength(1);
  });
  it('cancels child queries when the root hierarchy is closed', async () => {
    let signal: AbortSignal | undefined;
    const expand = vi.fn((_location: SourceLocation, _operation: string, abort: AbortSignal) => {
      signal = abort;
      return new Promise<NavigationBatch>(() => {});
    });
    const view = render(
      <HierarchyTree
        batch={result([root])}
        operation="typeHierarchy"
        title="Type hierarchy"
        loading={false}
        onExpand={expand}
        onOpen={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'ArrowRight' });
    await waitFor(() => expect(expand).toHaveBeenCalledOnce());
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });
  it('reports limited child coverage instead of a complete empty leaf', async () => {
    render(
      <HierarchyTree
        batch={result([root])}
        operation="typeHierarchy"
        title="Type hierarchy"
        loading={false}
        onExpand={async () => ({
          ...result([]),
          state: 'partial',
          reasons: ['Module unavailable'],
          searchedContexts: 0,
        })}
        onOpen={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'ArrowRight' });
    expect(await screen.findByText('Module unavailable')).toBeTruthy();
    expect(screen.queryByText('No further relationships.')).toBeNull();
  });
});
