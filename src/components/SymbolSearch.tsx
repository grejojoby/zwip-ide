import { useEffect, useRef, useState } from 'react';
import type { NavigationBatch, SourceLocation } from '../contracts';
import { asError } from '../model/document-session';
import { Modal } from './Modal';
import { Icon } from './Icon';
export function SymbolSearch({
  onSearch,
  onChoose,
  onClose,
}: {
  onSearch(query: string, signal: AbortSignal): Promise<NavigationBatch>;
  onChoose(location: SourceLocation): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState('');
  const [batch, setBatch] = useState<NavigationBatch | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(0);
  const [scroll, setScroll] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef(onSearch);
  search.current = onSearch;
  useEffect(() => {
    const controller = new AbortController();
    setSelected(0);
    setBatch(null);
    setError('');
    if (!query.trim()) {
      setLoading(false);
      return () => controller.abort();
    }
    setLoading(true);
    const timer = setTimeout(() => {
      void search
        .current(query, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) setBatch(result);
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(asError(e).message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 180);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query]);
  const locations = batch?.locations ?? [];
  const target = locations[selected];
  const start = Math.max(0, Math.floor(scroll / 40) - 3);
  function select(index: number) {
    const next = Math.max(0, Math.min(locations.length - 1, index));
    setSelected(next);
    if (list.current) {
      if (next * 40 < list.current.scrollTop) list.current.scrollTop = next * 40;
      else if ((next + 1) * 40 > list.current.scrollTop + list.current.clientHeight)
        list.current.scrollTop = (next + 1) * 40 - list.current.clientHeight;
    }
  }
  return (
    <Modal title="Go to symbol" wide onClose={onClose}>
      <div className="search-input">
        <Icon name="search" />
        <input
          data-autofocus
          aria-label="Search workspace symbols"
          aria-controls="workspace-symbol-options"
          aria-activedescendant={target ? `workspace-symbol-${selected}` : undefined}
          aria-autocomplete="list"
          value={query}
          placeholder="Symbol name across workspace languages…"
          onChange={(e) => {
            setQuery(e.target.value);
            setBatch(null);
            setSelected(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              select(selected + (e.key === 'ArrowDown' ? 1 : -1));
            }
            if (e.key === 'Enter' && target) {
              e.preventDefault();
              onChoose(target);
            }
          }}
        />
      </div>
      <div className="symbol-search-content">
        <div
          ref={list}
          className="symbol-search-list"
          id="workspace-symbol-options"
          role="listbox"
          aria-label="Workspace symbols"
          aria-busy={loading}
          onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
        >
          <div style={{ height: locations.length * 40, position: 'relative' }}>
            {locations.slice(start, start + 30).map((location, index) => {
              const item = start + index;
              return (
                <button
                  id={`workspace-symbol-${item}`}
                  role="option"
                  aria-selected={selected === item}
                  key={`${location.path}:${location.range.start.line}:${item}`}
                  className={`symbol-search-row ${selected === item ? 'selected' : ''}`}
                  style={{ top: item * 40 }}
                  onClick={() => onChoose(location)}
                  onMouseEnter={() => setSelected(item)}
                >
                  <strong>{location.name}</strong>
                  <span>
                    {location.path}:{location.range.start.line + 1}
                  </span>
                </button>
              );
            })}
          </div>
          {!locations.length && (
            <p className="empty-note">
              {loading
                ? 'Searching included language contexts…'
                : !query.trim()
                  ? 'Type to search symbols in every supported workspace context.'
                  : batch?.state === 'complete'
                    ? 'No symbols match in the searched contexts.'
                    : 'Search is incomplete. See coverage details below.'}
            </p>
          )}
        </div>
        <aside className="symbol-search-preview">
          {target ? (
            <>
              <strong>{target.name}</strong>
              <span>
                {target.contextIds.length} contexts · {target.relationship}
              </span>
              <pre>{target.preview}</pre>
              <code>{target.path}</code>
            </>
          ) : (
            <p>Select a result to preview its declaration.</p>
          )}
        </aside>
      </div>
      {error && (
        <p className="inline-notice error-message" role="alert">
          {error}
        </p>
      )}
      {batch?.reasons.map((reason) => (
        <p key={reason} className="inline-notice">
          {reason}
        </p>
      ))}
      <div className="modal-actions">
        <span>
          {batch
            ? `${batch.state} · ${batch.searchedContexts}/${batch.totalContexts} contexts · ${batch.locations.length} symbols`
            : '↑ ↓ Select · Enter Open · Esc Close'}
        </span>
      </div>
    </Modal>
  );
}
