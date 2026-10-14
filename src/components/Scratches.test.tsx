// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NewScratchDialog, ScratchList } from './Scratches';
afterEach(cleanup);
HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute('open', '');
};

it('filters scratch types and creates the highlighted one with Enter', () => {
  const onCreate = vi.fn();
  render(<NewScratchDialog onCreate={onCreate} onClose={() => {}} />);
  const input = screen.getByLabelText('Scratch file type');
  fireEvent.change(input, { target: { value: 'js' } });
  expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
    'JSON.json',
    'JavaScript.js',
  ]);
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ extension: 'js' }));
});

it('lists scratches, opens them, and deletes only after confirming', () => {
  const onOpen = vi.fn();
  const onDelete = vi.fn();
  render(
    <ScratchList
      files={[{ path: '/data/scratches/scratch.go', name: 'scratch.go', size: 1, modified: 1 }]}
      onOpen={onOpen}
      onDelete={onDelete}
      onNew={() => {}}
    />,
  );
  fireEvent.click(screen.getByTitle('/data/scratches/scratch.go'));
  expect(onOpen).toHaveBeenCalledWith('/data/scratches/scratch.go');
  fireEvent.click(screen.getByRole('button', { name: 'Delete scratch.go' }));
  expect(onDelete).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(onDelete).toHaveBeenCalledWith('/data/scratches/scratch.go');
});
