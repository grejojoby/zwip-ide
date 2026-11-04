// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SqlCertificateDialog, isSqlServerCertificateError } from './SqlCertificateDialog';
import { connectionApi } from './tool-api';
import type { Connection } from '../../contracts';

vi.mock('./tool-api', () => ({ connectionApi: { trustCertificate: vi.fn() } }));
const connection: Connection = {
  id: 'reporting',
  kind: 'mssql',
  name: 'Reporting',
  config: { host: 'sql.example', port: 1433, database: 'reports', tls: true },
};
beforeEach(() => {
  vi.resetAllMocks();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
});
afterEach(cleanup);

it('focuses Cancel and leaves the saved connection untouched when dismissed', () => {
  const close = vi.fn();
  render(<SqlCertificateDialog connection={connection} onClose={close} onSaved={vi.fn()} />);
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(close).toHaveBeenCalledOnce();
  expect(connectionApi.trustCertificate).not.toHaveBeenCalled();
});

it('keeps a failed save visible and allows retry without claiming trust was saved', async () => {
  vi.mocked(connectionApi.trustCertificate).mockRejectedValue(
    new Error('Connection settings changed.'),
  );
  const saved = vi.fn();
  render(<SqlCertificateDialog connection={connection} onClose={vi.fn()} onSaved={saved} />);
  fireEvent.click(screen.getByRole('button', { name: 'Trust and save' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Connection settings changed.');
  expect(saved).not.toHaveBeenCalled();
  expect(
    (screen.getByRole('button', { name: 'Trust and save' }) as HTMLButtonElement).disabled,
  ).toBe(false);
});

it('prevents duplicate saves and keeps the dialog open until the save finishes', async () => {
  let finish!: (connections: Connection[]) => void;
  vi.mocked(connectionApi.trustCertificate).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const close = vi.fn();
  const saved = vi.fn();
  render(<SqlCertificateDialog connection={connection} onClose={close} onSaved={saved} />);
  const trust = screen.getByRole('button', { name: 'Trust and save' });
  fireEvent.click(trust);
  fireEvent.click(trust);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(close).not.toHaveBeenCalled();
  expect(connectionApi.trustCertificate).toHaveBeenCalledOnce();
  const updated = {
    ...connection,
    config: { ...connection.config, tls: true, trustServerCertificate: true },
  };
  await act(async () => finish([updated]));
  await waitFor(() => expect(saved).toHaveBeenCalledExactlyOnceWith(updated));
});

it.each([
  new Error('SQL Server certificate verification failed.'),
  { code: -32603, message: 'self-signed certificate' },
  'unable to get local issuer certificate',
  'certificate has expired',
  'ERR_TLS_CERT_ALTNAME_INVALID',
])('recognizes SQL certificate verification errors: %s', (error) => {
  expect(isSqlServerCertificateError(error)).toBe(true);
});

it.each(['Login failed for user demo', 'Connection timed out', 'Invalid SQL syntax'])(
  'keeps unrelated SQL failures out of the trust prompt: %s',
  (error) => {
    expect(isSqlServerCertificateError(error)).toBe(false);
  },
);
