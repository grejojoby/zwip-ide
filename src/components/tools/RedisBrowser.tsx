import { useEffect, useRef, useState } from 'react';
import { asError } from '../../model/document-session';
import { toolRequest, type Connection } from './tool-api';
interface RedisPage {
  cursor: string;
  keys: string[];
  complete: boolean;
}
interface RedisValue {
  key: string;
  type: string;
  ttl: number;
  value: unknown;
  cursor: string;
  truncated: boolean;
  hasMore: boolean;
}
export function RedisBrowser({ connection }: { connection: Connection }) {
  const [pattern, setPattern] = useState('*');
  const [keys, setKeys] = useState<string[]>([]);
  const [cursor, setCursor] = useState('0');
  const [complete, setComplete] = useState(false);
  const [retentionLimited, setRetentionLimited] = useState(false);
  const [value, setValue] = useState<RedisValue | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const scannedPattern = useRef('');
  const [scrollTop, setScrollTop] = useState(0);
  useEffect(() => {
    ++epoch.current;
    void scan(true);
    return () => {
      ++epoch.current;
      void toolRequest('redis', 'disconnect', { connectionId: connection.id }).catch(() => {});
    };
  }, [connection.id]);
  async function scan(reset: boolean) {
    const currentEpoch = ++epoch.current;
    const requestedPattern = pattern || '*';
    reset ||= requestedPattern !== scannedPattern.current;
    setBusy(true);
    setError('');
    try {
      const result = await toolRequest<RedisPage>('redis', 'keys', {
        connectionId: connection.id,
        pattern: requestedPattern,
        cursor: reset ? '0' : cursor,
      });
      if (epoch.current === currentEpoch) {
        const next = [...new Set([...(reset ? [] : keys), ...result.keys])];
        setRetentionLimited(next.length > 10000 || (!reset && retentionLimited));
        setKeys(next.slice(-10000));
        scannedPattern.current = requestedPattern;
        setCursor(result.cursor);
        setComplete(result.complete);
      }
    } catch (e) {
      if (epoch.current === currentEpoch) setError(asError(e).message);
    } finally {
      if (epoch.current === currentEpoch) setBusy(false);
    }
  }
  async function inspect(key: string, next = false) {
    const currentEpoch = ++epoch.current;
    setBusy(true);
    setError('');
    const nextOffset = next && value?.type === 'list' ? offset + 100 : 0;
    try {
      const result = await toolRequest<RedisValue>('redis', 'inspect', {
        connectionId: connection.id,
        key,
        cursor: next ? value?.cursor : '0',
        offset: nextOffset,
      });
      if (epoch.current === currentEpoch) {
        setValue(result);
        setOffset(nextOffset);
      }
    } catch (e) {
      if (epoch.current === currentEpoch) setError(asError(e).message);
    } finally {
      if (epoch.current === currentEpoch) setBusy(false);
    }
  }
  return (
    <section className="redis-browser" aria-label="Redis keys">
      <form
        className="redis-filter"
        onSubmit={(e) => {
          e.preventDefault();
          void scan(true);
        }}
      >
        <input
          aria-label="Redis key pattern"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          placeholder="Key pattern"
        />
        <button disabled={busy}>Scan</button>
      </form>
      {error && (
        <p role="alert" className="inline-notice error-message">
          {error}
        </p>
      )}
      {retentionLimited && (
        <p className="inline-notice">
          Showing the latest 10,000 keys. Use a narrower pattern to inspect earlier keys.
        </p>
      )}
      <div className="redis-key-list" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <div style={{ height: keys.length * 27, position: 'relative' }}>
          <div
            style={{
              position: 'absolute',
              top: Math.max(0, Math.floor(scrollTop / 27) - 5) * 27,
              left: 0,
              right: 0,
            }}
          >
            {keys
              .slice(Math.max(0, Math.floor(scrollTop / 27) - 5), Math.floor(scrollTop / 27) + 25)
              .map((key) => (
                <button
                  key={key}
                  className={value?.key === key ? 'selected' : ''}
                  disabled={busy}
                  onClick={() => void inspect(key)}
                >
                  {key}
                </button>
              ))}
          </div>
        </div>
        {!keys.length && !busy && (
          <p className="empty-note">
            {complete ? 'No matching keys.' : 'No keys in this batch. Continue scanning.'}
          </p>
        )}
      </div>
      <div className="tool-section-title">
        <span>
          {keys.length} keys collected · {complete ? 'Scan complete' : 'More keys may exist'}
        </span>
        {!complete && (
          <button disabled={busy} onClick={() => void scan(false)}>
            Load more
          </button>
        )}
      </div>
      {value && (
        <div className="redis-value">
          <div className="tool-section-title">
            <strong>{value.key}</strong>
            <span>{value.type}</span>
          </div>
          <div className="panel-footnote">
            {value.ttl === -1
              ? 'No expiry'
              : value.ttl === -2
                ? 'Key no longer exists'
                : `TTL ${value.ttl} seconds`}{' '}
            · Read only
          </div>
          <pre>
            {typeof value.value === 'string' ? value.value : JSON.stringify(value.value, null, 2)}
          </pre>
          {value.hasMore && (
            <button disabled={busy} onClick={() => void inspect(value.key, true)}>
              Next values
            </button>
          )}
          {value.truncated && (
            <p className="inline-notice">Showing a bounded preview of this value.</p>
          )}
        </div>
      )}
    </section>
  );
}
