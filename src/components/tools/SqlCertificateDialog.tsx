import { useRef, useState } from 'react';
import type { Connection } from '../../contracts';
import { asError } from '../../model/document-session';
import { Modal } from '../Modal';
import { connectionApi } from './tool-api';

export function isSqlServerCertificateError(error: unknown): boolean {
  return /SQL Server certificate verification failed|self[- ]signed certificate|unable to verify (?:the )?(?:first|leaf) certificate|unable to get (?:local )?issuer certificate|certificate has expired|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME_INVALID/i.test(
    asError(error).message,
  );
}

export function SqlCertificateDialog({
  connection,
  onSaved,
  onClose,
}: {
  connection: Connection;
  onSaved(connection: Connection): void;
  onClose(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const saving = useRef(false);
  async function trust() {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      const connections = await connectionApi.trustCertificate(connection);
      const updated = connections.find((item) => item.id === connection.id);
      if (!updated) throw new Error('The saved connection could not be reloaded.');
      onSaved(updated);
    } catch (e) {
      setError(asError(e).message);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal title="Trust SQL Server certificate?" onClose={onClose} dismissible={!busy}>
      <div className="modal-body">
        <p>Zwip could not verify the certificate for this SQL Server.</p>
        <dl>
          <dt>Saved connection</dt>
          <dd>{connection.name}</dd>
          <dt>Server</dt>
          <dd>
            {connection.config.host ?? '127.0.0.1'}:{connection.config.port ?? 1433}
          </dd>
          <dt>Database</dt>
          <dd>{connection.config.database || 'Default database'}</dd>
        </dl>
        <p>
          Encryption stays enabled, but server identity will not be verified for this saved
          connection. Trust it only if you recognize the server.
        </p>
        <p className="muted">
          To keep certificate verification, trust the server’s CA in your system certificate store,
          restart Zwip, then try again. You can change this choice later in Edit connection.
        </p>
        <p>Your SQL command will not run automatically after saving.</p>
        {error && (
          <p role="alert" className="error-message">
            {error}
          </p>
        )}
      </div>
      <div className="modal-actions">
        <button data-autofocus disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button className="primary" disabled={busy} onClick={() => void trust()}>
          {busy ? 'Saving…' : 'Trust and save'}
        </button>
      </div>
    </Modal>
  );
}
