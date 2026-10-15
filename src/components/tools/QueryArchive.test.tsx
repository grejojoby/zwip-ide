// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { request } from '../../api';
import { QueryArchive } from './QueryArchive';
vi.mock('../../api', () => ({ request: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
});
afterEach(cleanup);
it('filters imported history and displays original SQL without running it', async () => {
  vi.mocked(request).mockImplementation(async (method) =>
    method === 'queryArchive.list'
      ? [
          { id: 'one', title: 'Unmapped legacy.sql', category: 'Query History' },
          { id: 'two', title: 'Local console.sql', category: 'Consoles' },
        ]
      : { content: '-- timestamp metadata\nSELECT 42;' },
  );
  render(<QueryArchive onClose={() => {}} />);
  await screen.findByRole('option', { name: /Local console/ });
  fireEvent.change(screen.getByLabelText('Filter archived queries'), {
    target: { value: 'legacy' },
  });
  expect(screen.queryByRole('option', { name: /Local console/ })).toBeNull();
  fireEvent.change(screen.getByLabelText('Archived query'), { target: { value: 'one' } });
  const text = (await screen.findByLabelText('Archived SQL')) as HTMLTextAreaElement;
  expect(text.value).toBe('-- timestamp metadata\nSELECT 42;');
  expect(text.readOnly).toBe(true);
  expect(vi.mocked(request).mock.calls).toEqual([
    ['queryArchive.list'],
    ['queryArchive.get', { id: 'one' }],
  ]);
});
it('reports archive errors instead of claiming it is empty', async () => {
  vi.mocked(request).mockRejectedValue(new Error('Invalid query archive index'));
  render(<QueryArchive onClose={() => {}} />);
  expect((await screen.findByRole('alert')).textContent).toContain('Invalid query archive index');
  expect(screen.queryByText('No queries have been imported.')).toBeNull();
});
