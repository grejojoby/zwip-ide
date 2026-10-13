import { useMemo } from 'react';
import type { NavigationBatch, SourceLocation } from '../contracts';
import { CodePreview } from '../editor/highlight';
import { Icon } from './Icon';
export function NavigationResults({
  batch,
  title,
  loading,
  onOpen,
  onCancel,
}: {
  batch: NavigationBatch | null;
  title: string;
  loading: boolean;
  onOpen(location: SourceLocation): void;
  onCancel(): void;
}) {
  const groups = useMemo(() => {
    const result = new Map<string, SourceLocation[]>();
    for (const location of batch?.locations ?? [])
      result.set(location.path, [...(result.get(location.path) ?? []), location]);
    return result;
  }, [batch]);
  return (
    <section className="results-panel" aria-label={title} aria-busy={loading}>
      <div className="results-summary">
        <strong>{title}</strong>
        <span>
          {batch &&
            `${batch.locations.length} result${batch.locations.length === 1 ? '' : 's'} · ${batch.searchedContexts}/${batch.totalContexts} contexts`}
        </span>
        <span className={`state-badge ${batch?.state === 'partial' ? 'warning' : ''}`}>
          {loading ? 'Searching…' : batch?.state}
        </span>
        {loading && <button onClick={onCancel}>Cancel</button>}
      </div>
      {batch?.reasons.map((reason) => (
        <div key={reason} className="inline-notice">
          {reason}
        </div>
      ))}
      <div className="results-list">
        {[...groups].map(([path, locations]) => (
          <div key={path} className="result-group">
            <div className="result-file" title={path}>
              <Icon name="file" />
              <strong>{path.split('/').pop()}</strong>
              <span>{path.slice(0, path.lastIndexOf('/'))}</span>
            </div>
            {locations.map((location, index) => (
              <button
                key={`${location.range.start.line}:${location.range.start.character}:${index}`}
                className="result-row"
                onClick={() => onOpen(location)}
              >
                <span className="line-number">{location.range.start.line + 1}</span>
                <CodePreview path={location.path} text={location.preview || location.name} />
                <span className="relationship">{location.relationship}</span>
              </button>
            ))}
          </div>
        ))}
        {!loading && !batch && (
          <p className="empty-note">Cmd-click a symbol to navigate. Use ⌥F7 to find usages.</p>
        )}
        {!loading && batch?.state === 'complete' && !batch.locations.length && (
          <p className="empty-note">No results in the searched contexts.</p>
        )}
        {!loading && batch && batch.state !== 'complete' && !batch.locations.length && (
          <p className="empty-note">No results available. Search coverage is {batch.state}.</p>
        )}
      </div>
    </section>
  );
}
