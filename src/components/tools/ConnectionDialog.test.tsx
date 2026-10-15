// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConnectionDialog } from './ConnectionDialog';
import { connectionApi } from './tool-api';
vi.mock('./tool-api', () => ({ connectionApi: { save: vi.fn() } }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
});
afterEach(cleanup);
it('saves SQL Server on port 1433 with verified TLS and a separately stored password', async () => {
  vi.mocked(connectionApi.save).mockResolvedValue([]);
  const onSave = vi.fn();
  render(<ConnectionDialog onSave={onSave} onClose={() => {}} />);
  fireEvent.change(screen.getByLabelText('Database', { exact: true }), {
    target: { value: 'mssql' },
  });
  expect((screen.getByLabelText('Port') as HTMLInputElement).value).toBe('1433');
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'SQL Server test' } });
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'demo' } });
  fireEvent.change(screen.getByLabelText('Password'), {
    target: { value: 'not-persisted-in-config' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  await waitFor(() => expect(onSave).toHaveBeenCalled());
  expect(connectionApi.save).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'mssql',
      config: {
        host: '127.0.0.1',
        port: 1433,
        database: '',
        username: 'demo',
        tls: true,
        trustServerCertificate: false,
      },
    }),
    'not-persisted-in-config',
  );
});
