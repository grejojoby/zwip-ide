// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DiffActionsContext } from './DiffActions';
import { BranchDiffWindow } from './BranchDiffWindow';

const calls: Record<string, unknown>[] = [];
const line = (kind: string, text: string, oldLine?: number, newLine?: number) => ({
  id: `${kind}:${oldLine}:${newLine}`,
  kind,
  text,
  oldLine,
  newLine,
});
vi.mock('../api', () => ({
  request: async (method: string, params: Record<string, unknown>) => {
    if (method === 'package.syntax') return null;
    calls.push(params);
    const context = Array.from({ length: 20 }, (_, at) =>
      line('context', `same ${at}`, at + 3, at + 3),
    );
    return {
      path: params.path,
      before: 'old\n',
      after: 'new\n',
      fingerprint: 'f1',
      kind: 'text',
      partialAllowed: true,
      base: 'base-commit',
      binary: false,
      hunks: [
        {
          id: 'h0',
          oldStart: 1,
          newStart: 1,
          lines: [
            line('remove', 'let total = 1;', 1),
            line('add', 'let total = 2;', undefined, 1),
            line('context', 'keep', 2, 2),
            ...context,
            line('add', 'inserted', undefined, 23),
          ],
        },
      ],
    };
  },
}));
beforeEach(() => {
  calls.length = 0;
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
});
afterEach(cleanup);

describe('branch diff window', () => {
  it('shows both versions side by side with word changes and folded unchanged lines', async () => {
    render(
      <BranchDiffWindow
        branch="master"
        files={[
          { status: 'M', path: 'src/b.ts' },
          { status: 'A', path: 'src/a.ts' },
        ]}
        onClose={() => {}}
      />,
    );
    const left = await screen.findByLabelText('master version');
    const right = screen.getByLabelText('Working tree version');
    expect(calls[0]).toEqual({ branch: 'master', path: 'src/a.ts' });
    expect(
      within(left).getByText('1', { selector: '.bdiff-number' }).closest('.bdiff-modified'),
    ).toBeTruthy();
    expect(within(right).getByText('2', { selector: '.bdiff-word' })).toBeTruthy();
    expect(screen.getByText('2 differences', { exact: false })).toBeTruthy();
    expect(within(left).getByText('13 unchanged lines')).toBeTruthy();
    fireEvent.click(within(left).getByText('13 unchanged lines'));
    // Built-in TypeScript highlighting splits a line into token spans; match the whole line.
    expect(
      within(right).getByText(
        (_, element) => element?.tagName === 'CODE' && element.textContent === 'same 10',
      ),
    ).toBeTruthy();
    expect(left.querySelector('.bdiff-gap.bdiff-inserted')).toBeTruthy();
  });
  it('moves to the next file from the tree and past the last difference with F7', async () => {
    render(
      <BranchDiffWindow
        branch="master"
        files={[
          { status: 'M', path: 'a.ts' },
          { status: 'D', path: 'b.ts' },
        ]}
        onClose={() => {}}
      />,
    );
    await screen.findByLabelText('master version');
    const tree = screen.getByRole('tree');
    fireEvent.keyDown(tree, { key: 'F7' });
    fireEvent.keyDown(tree, { key: 'F7' });
    await screen.findByText('file 2 of 2', { exact: false });
    expect(calls.at(-1)).toEqual({ branch: 'master', path: 'b.ts' });
    fireEvent.keyDown(tree, { key: 'ArrowUp' });
    expect(screen.getByRole('treeitem', { selected: true }).textContent).toBe('a.ts');
  });
});

it('offers file and current-difference revert, and edits the selected branch comparison', async () => {
  const edit = vi.fn(async () => {});
  const close = vi.fn();
  render(
    <DiffActionsContext.Provider value={{ edit }}>
      <BranchDiffWindow branch="main" files={[{ path: 'a.ts', status: 'M' }]} onClose={close} />
    </DiffActionsContext.Provider>,
  );
  await screen.findByLabelText('main version');
  expect(screen.getByRole('button', { name: 'Revert file…' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Revert current difference…' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Edit file' }));
  await vi.waitFor(() => expect(close).toHaveBeenCalled());
  expect(edit).toHaveBeenCalledWith(expect.objectContaining({ path: 'a.ts', base: 'base-commit' }));
});
