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
