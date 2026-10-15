import { useEffect, useState } from 'react';
import type { SqlProcedure, SqlProcedureDetails } from '../../contracts';
import { asError } from '../../model/document-session';
import { Modal } from '../Modal';
import { toolRequest } from './tool-api';
const keyOf = (item: SqlProcedure) => JSON.stringify([item.schema, item.name]);
export function StoredProcedures({
  connectionId,
  onClose,
}: {
  connectionId: string;
  onClose(): void;
}) {
  const [procedures, setProcedures] = useState<SqlProcedure[] | null>(null);
  const [selected, setSelected] = useState('');
  const [filter, setFilter] = useState('');
  const [details, setDetails] = useState<SqlProcedureDetails | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let current = true;
    toolRequest<SqlProcedure[]>('sql', 'procedures', { connectionId })
      .then((items) => {
        if (current) setProcedures(items);
      })
      .catch((e) => {
        if (current) setError(asError(e).message);
      });
    return () => {
      current = false;
    };
  }, [connectionId]);
  useEffect(() => {
    let current = true;
    const procedure = procedures?.find((item) => keyOf(item) === selected);
    setDetails(null);
    if (!procedure) {
      setLoading(false);
      if (procedures) setError('');
      return;
    }
    setError('');
    setLoading(true);
    toolRequest<SqlProcedureDetails>('sql', 'procedureDetails', {
      connectionId,
      schema: procedure.schema,
      procedure: procedure.name,
    })
      .then((value) => {
        if (current) setDetails(value);
      })
      .catch((e) => {
        if (current) setError(asError(e).message);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [connectionId, selected, procedures]);
  return (
    <Modal title="Stored procedures" onClose={onClose} wide>
      <div className="modal-body procedure-viewer">
        <label className="field-label">
          Filter procedures
          <input
            data-autofocus
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Schema or procedure name…"
          />
        </label>
        <label className="field-label">
          Stored procedure
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={!procedures}
          >
            <option value="">Choose a stored procedure…</option>
            {procedures
              ?.filter(
                (item) =>
                  keyOf(item) === selected ||
                  `${item.schema}.${item.name}`.toLowerCase().includes(filter.toLowerCase()),
              )
              .map((item) => (
                <option key={keyOf(item)} value={keyOf(item)}>
                  {item.schema}.{item.name}
                </option>
              ))}
          </select>
        </label>
        {!procedures && !error && <p role="status">Loading stored procedures…</p>}
        {procedures?.length === 0 && (
          <p>
            No stored procedures are visible in this database. Metadata visibility depends on your
            login’s permissions.
          </p>
        )}
        {loading && <p role="status">Loading procedure details…</p>}
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        {details && (
          <>
            <h3>
              {details.schema}.{details.name}
            </h3>
            <h4>Documentation</h4>
            <p className="procedure-description">
              {details.description ||
                'No MS_Description documentation is visible for this procedure.'}
            </p>
            <h4>Parameters</h4>
            {details.parameters.length ? (
              <dl className="procedure-parameters">
                {details.parameters.map((parameter) => (
                  <div key={parameter.name}>
                    <dt>
                      <code>
                        {parameter.name} {parameter.type}
                        {parameter.output ? ' OUTPUT' : ''}
                      </code>
                    </dt>
                    <dd>{parameter.description || 'No parameter documentation.'}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p>No parameters are visible.</p>
            )}
            <h4>SQL definition</h4>
            {details.definition !== null ? (
              <pre className="procedure-definition" tabIndex={0}>
                {details.definition}
              </pre>
            ) : (
              <p>
                Definition unavailable: the procedure may be encrypted, implemented in CLR, or
                require VIEW DEFINITION permission.
              </p>
            )}
          </>
        )}
      </div>
      <div className="modal-actions">
        <button onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
