// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StoredProcedures } from './StoredProcedures';
import { toolRequest } from './tool-api';
vi.mock('./tool-api', () => ({ toolRequest: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
});
afterEach(cleanup);
it('shows documentation, definition, and parameters for the chosen schema-qualified procedure', async () => {
  vi.mocked(toolRequest).mockImplementation(async (_, method) =>
    method === 'procedures'
      ? [{ schema: 'sales', name: 'FindOrder' }]
      : {
          schema: 'sales',
          name: 'FindOrder',
          description: 'Find an order by ID.',
          definition: 'CREATE PROCEDURE sales.FindOrder @id int AS SELECT @id;',
          parameters: [
            { name: '@id', type: '[sys].[int]', output: false, description: 'Order identifier' },
          ],
        },
  );
  render(<StoredProcedures connectionId="c1" onClose={() => {}} />);
  await screen.findByRole('option', { name: 'sales.FindOrder' });
  fireEvent.change(screen.getByLabelText('Stored procedure'), {
    target: { value: JSON.stringify(['sales', 'FindOrder']) },
  });
  expect(await screen.findByText('Find an order by ID.')).toBeTruthy();
  expect(screen.getByText('Order identifier')).toBeTruthy();
  expect(screen.getByText(/CREATE PROCEDURE/)).toBeTruthy();
  expect(toolRequest).toHaveBeenLastCalledWith('sql', 'procedureDetails', {
    connectionId: 'c1',
    schema: 'sales',
    procedure: 'FindOrder',
  });
});
it('distinguishes missing descriptions and unavailable definitions', async () => {
  vi.mocked(toolRequest).mockImplementation(async (_, method) =>
    method === 'procedures'
      ? [{ schema: 'dbo', name: 'Hidden' }]
      : { schema: 'dbo', name: 'Hidden', description: null, definition: null, parameters: [] },
  );
  render(<StoredProcedures connectionId="c1" onClose={() => {}} />);
  await screen.findByRole('option', { name: 'dbo.Hidden' });
  fireEvent.change(screen.getByLabelText('Stored procedure'), {
    target: { value: JSON.stringify(['dbo', 'Hidden']) },
  });
  expect(
    await screen.findByText('No MS_Description documentation is visible for this procedure.'),
  ).toBeTruthy();
  expect(screen.getByText(/Definition unavailable/)).toBeTruthy();
});
it('shows a failed catalog request as an error instead of an empty result', async () => {
  vi.mocked(toolRequest).mockRejectedValue(new Error('Permission denied'));
  render(<StoredProcedures connectionId="c1" onClose={() => {}} />);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Permission denied'));
  expect(screen.queryByText(/No stored procedures/)).toBeNull();
});
