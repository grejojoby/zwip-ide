import { useEffect, useRef, useState } from 'react';
import { asError } from '../../model/document-session';
import { toolRequest } from './tool-api';
import type { HttpResponse } from '../../contracts';
export function HttpPanel({ source: initialSource }: { source: string }) {
  const [source, setSource] = useState(initialSource);
  const [environment, setEnvironment] = useState('{}');
  const [requestIndex, setRequestIndex] = useState(0);
  const [response, setResponse] = useState<HttpResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'body' | 'headers'>('body');
  const [fullBody, setFullBody] = useState(false);
  const runningId = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (runningId.current)
        void toolRequest('http', 'cancel', { id: runningId.current }).catch(() => {});
    };
  }, []);
  const sections = source
    .replace(/^@([\w.-]+)\s*=\s*(.*)$/gm, '')
    .split(/^###.*$/m)
    .map((section) => section.trim())
    .filter((section) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s/m.test(section));
  async function execute() {
    setBusy(true);
    setError('');
    setFullBody(false);
    const id = crypto.randomUUID();
    runningId.current = id;
    try {
      const values: unknown = JSON.parse(environment || '{}');
      if (
        !values ||
        typeof values !== 'object' ||
        Array.isArray(values) ||
        Object.values(values).some((value) => typeof value !== 'string')
      )
        throw new Error('Environment must be a JSON object containing string values.');
      const result = await toolRequest<HttpResponse>('http', 'execute', {
        id,
        source,
        requestIndex: Math.min(requestIndex, Math.max(0, sections.length - 1)),
        environment: values,
      });
      if (mounted.current && runningId.current === id) setResponse(result);
    } catch (e) {
      if (mounted.current && runningId.current === id) setError(asError(e).message);
    } finally {
      if (runningId.current === id) {
        runningId.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  }
  async function cancel() {
    const id = runningId.current;
    if (!id) return;
    try {
      await toolRequest('http', 'cancel', { id });
    } catch (e) {
      setError(asError(e).message);
    }
  }
  return (
    <section className="http-panel" aria-label="HTTP client">
      <div className="tool-section-title">
        <strong>Request</strong>
        <select
          aria-label="Request in HTTP file"
          value={Math.min(requestIndex, Math.max(0, sections.length - 1))}
          onChange={(e) => setRequestIndex(Number(e.target.value))}
        >
          {sections.map((section, index) => (
            <option key={index} value={index}>
              {index + 1}.{' '}
              {section
                .split('\n')
                .find((line) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s/.test(line)) ??
                'Request'}
            </option>
          ))}
        </select>
        <button
          className="primary"
          disabled={busy || !source.trim()}
          onClick={() => void execute()}
        >
          Send
        </button>
        <button disabled={!busy} onClick={() => void cancel()}>
          Cancel
        </button>
      </div>
      <textarea
        className="http-source"
        aria-label="HTTP request source"
        value={source}
        onChange={(e) => {
          setSource(e.target.value);
          setRequestIndex(0);
        }}
        spellCheck={false}
        placeholder={
          'GET https://your-service.example/api\nAccept: application/json\nAuthorization: Bearer {{token}}'
        }
      />
      <details className="environment-editor">
        <summary>Request environment</summary>
        <textarea
          aria-label="HTTP environment variables"
          value={environment}
          onChange={(e) => setEnvironment(e.target.value)}
          spellCheck={false}
        />
        <p>String values only. Variables use {'{{name}}'}. Values stay in this panel.</p>
      </details>
      {error && (
        <p className="inline-notice error-message" role="alert">
          {error}
        </p>
      )}
      {response ? (
        <>
          <div className="response-summary">
            <strong className={response.status >= 400 ? 'error-message' : ''}>
              {response.status} {response.statusText}
            </strong>
            <span>
              {Math.round(response.durationMs)} ms · {response.bytes.toLocaleString()} bytes
            </span>
          </div>
          <div className="response-tabs">
            <button aria-pressed={tab === 'body'} onClick={() => setTab('body')}>
              Body
            </button>
            <button aria-pressed={tab === 'headers'} onClick={() => setTab('headers')}>
              Headers
            </button>
            <span>{response.encoding === 'base64' ? 'Binary · base64' : 'Text'}</span>
          </div>
          {response.truncated && (
            <p className="inline-notice">Response exceeded the 2 MiB collection limit.</p>
          )}
          {tab === 'headers' ? (
            <dl className="http-headers">
              {Object.entries(response.headers).map(([name, value]) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <>
              <pre className="http-response">
                {fullBody ? response.body : response.body.slice(0, 262144)}
              </pre>
              {response.body.length > 262144 && !fullBody && (
                <button onClick={() => setFullBody(true)}>Show the full collected response</button>
              )}
            </>
          )}
        </>
      ) : (
        <p className="empty-note">Send a request to inspect its response.</p>
      )}
    </section>
  );
}
