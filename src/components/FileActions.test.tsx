// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { request } from '../api';
import { FileActions } from './FileActions';
vi.mock('../api', () => ({ request: vi.fn() }));
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const open = () => fireEvent.click(screen.getByRole('button', { name: 'Project file actions' }));

describe('project file action reviews', () => {
  it('requires a preview before moving a file and rejects stale apply without closing', async () => {
    const applied = vi.fn();
    const flush = vi.fn().mockResolvedValue(undefined);
    vi.mocked(request).mockImplementation(async (method) => {
      if (method === 'workspace.filePreview')
        return {
          id: 'plan',
          operation: 'rename',
          path: '/project/a.ts',
          destination: '/project/b.ts',
          bytes: 12,
        };
      throw new Error('File changed after preview; review again.');
    });
    render(
      <FileActions
        root="/project"
        activePath="/project/a.ts"
        beforeMutation={flush}
        onApplied={applied}
      />,
    );
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Rename or move file…' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Project relative path' }), {
      target: { value: 'b.ts' },
    });
    expect(request).not.toHaveBeenCalled();
    fireEvent.submit(document.getElementById('file-action-form')!);
    expect(await screen.findByText('/project/b.ts')).toBeTruthy();
    expect(request).toHaveBeenCalledWith('workspace.filePreview', {
      operation: 'rename',
      path: '/project/a.ts',
      destination: 'b.ts',
    });
    expect(request).not.toHaveBeenCalledWith('workspace.fileApply', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: 'Apply move' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Error: File changed after preview; review again.',
    );
    expect(applied).not.toHaveBeenCalled();
    expect(flush).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
  it('does not request a mutation when editor synchronization fails', async () => {
    render(
      <FileActions
        root="/project"
        activePath="/project/a.ts"
        beforeMutation={async () => {
          throw new Error('Pending edits could not be synchronized.');
        }}
        onApplied={vi.fn()}
      />,
    );
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Move file to IDE trash…' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Error: Pending edits could not be synchronized.',
    );
    expect(request).not.toHaveBeenCalled();
  });
  it('keeps trash recovery scoped to the selected entry and refreshes after restore', async () => {
    const applied = vi.fn().mockResolvedValue(undefined);
    let restored = false;
    vi.mocked(request).mockImplementation(async (method, params) => {
      if (method === 'workspace.trashList')
        return restored
          ? []
          : [{ id: 'trash-1', path: '/project/a.ts', bytes: 2, createdAt: 1, available: true }];
      expect(method).toBe('workspace.trashRestore');
      expect(params).toEqual({ id: 'trash-1' });
      restored = true;
      return { path: '/project/a.ts' };
    });
    render(<FileActions root="/project" beforeMutation={async () => {}} onApplied={applied} />);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Recover trashed files…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    await waitFor(() =>
      expect(applied).toHaveBeenCalledWith({ operation: 'restore', path: '/project/a.ts' }),
    );
    expect(await screen.findByText('No recoverable files in this project.')).toBeTruthy();
  });
});
