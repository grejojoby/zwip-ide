// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PartialDiff } from './PartialDiff';
import type { GitDiff } from '../contracts';
const diff: GitDiff = {
  path: 'example.txt',
  before: 'old\n',
  after: 'new\n',
  patch: '',
  binary: false,
  fingerprint: 'revision',
  kind: 'text',
  partialAllowed: true,
  hunks: [
    {
      id: 'hunk',
      oldStart: 1,
      newStart: 1,
      lines: [
        { id: 'remove', kind: 'remove', text: 'old', oldLine: 1 },
        { id: 'add', kind: 'add', text: 'new', newLine: 1 },
      ],
    },
  ],
};
afterEach(cleanup);
describe('partial commit selection', () => {
  it('selects the exact addition or entire hunk without silently selecting context', () => {
    const select = vi.fn();
    render(<PartialDiff diff={diff} selected={new Set()} onSelect={select} />);
    fireEvent.click(screen.getByLabelText('Include add at line 1'));
    expect([...select.mock.calls[0][0]]).toEqual(['add']);
    fireEvent.click(screen.getByLabelText('Include hunk at line 1'));
    expect([...select.mock.calls[1][0]]).toEqual(['remove', 'add']);
  });
  it('visibly distinguishes excluded edits in the final commit preview', () => {
    render(<PartialDiff diff={diff} selected={new Set(['add'])} onSelect={() => {}} readOnly />);
    expect(screen.getByText('included')).toBeTruthy();
    expect(screen.getByText('excluded')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});

describe('side by side diff', () => {
  const paired: GitDiff = {
    ...diff,
    hunks: [
      {
        id: 'h',
        oldStart: 1,
        newStart: 1,
        lines: [
          { id: 'c1', kind: 'context', text: 'keep', oldLine: 1, newLine: 1 },
          { id: 'r1', kind: 'remove', text: 'old one', oldLine: 2 },
          { id: 'r2', kind: 'remove', text: 'old two', oldLine: 3 },
          { id: 'a1', kind: 'add', text: 'new one', newLine: 2 },
          { id: 'c2', kind: 'context', text: 'end', oldLine: 4, newLine: 3 },
        ],
      },
    ],
  };
  it('puts removals on the left and additions on the right, with empty padding', () => {
    const { container } = render(
      <PartialDiff diff={paired} selected={new Set()} onSelect={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Side by side' }));
    const rows = [...container.querySelectorAll('.split-diff-row')];
    expect(rows).toHaveLength(4);
    const [removed, added] = rows[1].querySelectorAll('.split-diff-cell');
    expect(removed.textContent).toContain('old one');
    expect(added.textContent).toContain('new one');
    const [leftover, padding] = rows[2].querySelectorAll('.split-diff-cell');
    expect(leftover.textContent).toContain('old two');
    expect(padding.classList.contains('split-diff-empty')).toBe(true);
  });
  it('keeps exact line selection in the split view', () => {
    const select = vi.fn();
    render(<PartialDiff diff={paired} selected={new Set()} onSelect={select} />);
    fireEvent.click(screen.getByRole('button', { name: 'Side by side' }));
    fireEvent.click(screen.getByLabelText('Include add at line 2'));
    expect([...select.mock.calls[0][0]]).toEqual(['a1']);
  });
});
