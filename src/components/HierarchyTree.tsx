import { useEffect, useMemo, useRef, useState } from 'react';
import type { NavigationBatch, SourceLocation } from '../contracts';
import { asError } from '../model/document-session';
import { Icon } from './Icon';
export type HierarchyOperation = 'typeHierarchy' | 'incomingCalls' | 'outgoingCalls';
interface Node {
  id: string;
  location: SourceLocation;
  parent?: string;
  ancestors: string[];
  children?: Node[];
  result?: NavigationBatch;
  expanded: boolean;
  loading: boolean;
  error?: string;
}
const locationKey = (location: SourceLocation) =>
  `${location.path}:${location.range.start.line}:${location.range.start.character}:${location.relationship}:${location.contextIds.join(',')}`;
const symbolKey = (location: SourceLocation) =>
  `${location.path}:${location.range.start.line}:${location.range.start.character}`;
export function HierarchyTree({
  batch,
  operation,
  title,
  loading,
  onExpand,
  onOpen,
  onCancel,
}: {
  batch: NavigationBatch | null;
  operation: HierarchyOperation;
  title: string;
  loading: boolean;
  onExpand(
    location: SourceLocation,
    operation: HierarchyOperation,
    signal: AbortSignal,
  ): Promise<NavigationBatch>;
  onOpen(location: SourceLocation): void;
  onCancel(): void;
}) {
  const [nodes, setNodes] = useState<Node[]>(() =>
    (batch?.locations ?? []).map((location, index) => ({
      id: `${index}:${locationKey(location)}`,
      location,
      ancestors: [],
      expanded: false,
      loading: false,
    })),
  );
  const [selection, setSelection] = useState(0);
  const [scroll, setScroll] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);
  const requests = useRef(new Map<string, AbortController>());
  const queryId = useRef(batch?.id);
  useEffect(() => {
    const replaced = queryId.current !== batch?.id;
    queryId.current = batch?.id;
    if (replaced) {
      for (const controller of requests.current.values()) controller.abort();
      requests.current.clear();
      setSelection(0);
      setScroll(0);
      if (viewport.current) viewport.current.scrollTop = 0;
    }
    setNodes((current) => {
      const previous = new Map(
        (replaced ? [] : current).map((node) => [locationKey(node.location), node]),
      );
      return (batch?.locations ?? []).map((location) => {
        const key = locationKey(location);
        const existing = previous.get(key);
        return existing
          ? { ...existing, location }
          : { id: `root:${key}`, location, ancestors: [], expanded: false, loading: false };
      });
    });
  }, [batch?.id, batch?.locations]);
  useEffect(
    () => () => {
      for (const controller of requests.current.values()) controller.abort();
      requests.current.clear();
    },
    [],
  );
  const rows = useMemo(() => {
    const result: { node: Node; level: number; index: number; siblings: number }[] = [];
    function visit(items: Node[], level: number) {
      items.forEach((node, index) => {
        result.push({ node, level, index, siblings: items.length });
        if (node.expanded && node.children) visit(node.children, level + 1);
      });
    }
    visit(nodes, 1);
    return result;
  }, [nodes]);
  const selected = rows[Math.min(selection, Math.max(0, rows.length - 1))]?.node;
  function update(id: string, change: (node: Node) => Node) {
    setNodes((current) => {
      function visit(items: Node[]): Node[] {
        return items.map((node) =>
          node.id === id
            ? change(node)
            : node.children
              ? { ...node, children: visit(node.children) }
              : node,
        );
      }
      return visit(current);
    });
  }
  async function expand(node: Node) {
    if (node.expanded) {
      update(node.id, (item) => ({ ...item, expanded: false }));
      return;
    }
    if (node.children) {
      update(node.id, (item) => ({ ...item, expanded: true }));
      return;
    }
    if (node.ancestors.includes(symbolKey(node.location))) {
      update(node.id, (item) => ({
        ...item,
        expanded: true,
        children: [],
        error: 'Recursive relationship; this symbol already appears above.',
      }));
      return;
    }
    const controller = new AbortController();
    requests.current.set(node.id, controller);
    update(node.id, (item) => ({ ...item, expanded: true, loading: true, error: undefined }));
    try {
      const result = await onExpand(node.location, operation, controller.signal);
      if (controller.signal.aborted) return;
      update(node.id, (item) => ({
        ...item,
        result,
        loading: false,
        children: result.locations.map((location, index) => ({
          id: `${node.id}/${index}:${locationKey(location)}`,
          parent: node.id,
          location,
          ancestors: [...node.ancestors, symbolKey(node.location)],
          expanded: false,
          loading: false,
        })),
      }));
    } catch (e) {
      if (!controller.signal.aborted)
        update(node.id, (item) => ({ ...item, loading: false, error: asError(e).message }));
    } finally {
      if (requests.current.get(node.id) === controller) requests.current.delete(node.id);
    }
  }
  function select(index: number) {
    const next = Math.max(0, Math.min(rows.length - 1, index));
    setSelection(next);
    const view = viewport.current;
    if (view) {
      const top = next * 28;
      if (top < view.scrollTop) view.scrollTop = top;
      else if (top + 28 > view.scrollTop + view.clientHeight)
        view.scrollTop = top + 28 - view.clientHeight;
    }
  }
  const start = Math.max(0, Math.floor(scroll / 28) - 5);
  return (
    <section className="hierarchy-panel" aria-label={title} aria-busy={loading}>
      <div className="results-summary">
        <strong>{title}</strong>
        <span>{batch && `${batch.searchedContexts}/${batch.totalContexts} contexts`}</span>
        <span className={`state-badge ${batch?.state === 'partial' ? 'warning' : ''}`}>
          {loading ? 'Searching…' : batch?.state}
        </span>
        {loading && <button onClick={onCancel}>Cancel</button>}
        <span className="hierarchy-help">← → Collapse / expand · Enter Open</span>
      </div>
      {batch?.reasons.map((reason) => (
        <p key={reason} className="inline-notice">
          {reason}
        </p>
      ))}
      <div className="hierarchy-body">
        <div
          ref={viewport}
          className="hierarchy-tree"
          role="tree"
          aria-label={`${title} relationships`}
          tabIndex={0}
          aria-activedescendant={
            selected ? `hierarchy-${encodeURIComponent(selected.id)}` : undefined
          }
          onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
          onKeyDown={(e) => {
            if (!selected) return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              select(selection + (e.key === 'ArrowDown' ? 1 : -1));
            } else if (e.key === 'ArrowRight') {
              e.preventDefault();
              if (!selected.expanded) void expand(selected);
              else if (selected.children?.length) select(selection + 1);
            } else if (e.key === 'ArrowLeft') {
              e.preventDefault();
              if (selected.expanded) update(selected.id, (item) => ({ ...item, expanded: false }));
              else if (selected.parent)
                select(rows.findIndex((item) => item.node.id === selected.parent));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              onOpen(selected.location);
            } else if (e.key === 'Home' || e.key === 'End') {
              e.preventDefault();
              select(e.key === 'Home' ? 0 : rows.length - 1);
            }
          }}
        >
          <div style={{ height: rows.length * 28, position: 'relative' }}>
            {rows.slice(start, start + 80).map(({ node, level, index, siblings }, visibleIndex) => (
              <div
                key={node.id}
                id={`hierarchy-${encodeURIComponent(node.id)}`}
                className={`hierarchy-row ${selected?.id === node.id ? 'selected' : ''}`}
                role="treeitem"
                aria-level={level}
                aria-posinset={index + 1}
                aria-setsize={siblings}
                aria-expanded={node.expanded}
                aria-selected={selected?.id === node.id}
                style={{ top: (start + visibleIndex) * 28, paddingLeft: 8 + (level - 1) * 16 }}
                onClick={() => select(start + visibleIndex)}
                onDoubleClick={() => onOpen(node.location)}
              >
                <button
                  tabIndex={-1}
                  aria-label={`${node.expanded ? 'Collapse' : 'Expand'} ${node.location.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    select(start + visibleIndex);
                    void expand(node);
                  }}
                >
                  <Icon
                    name="chevron"
                    style={{ transform: node.expanded ? 'rotate(90deg)' : undefined }}
                  />
                </button>
                <strong>{node.location.name}</strong>
                <span>{node.location.relationship}</span>
                <small>
                  {node.location.path.split('/').pop()}:{node.location.range.start.line + 1}
                </small>
                {node.loading && <small>Loading…</small>}
                {node.result && node.result.state !== 'complete' && (
                  <small className="warning">{node.result.state}</small>
                )}
                {node.error && <small className="error-message">!</small>}
              </div>
            ))}
          </div>
          {!rows.length && !loading && (
            <p className="empty-note">
              {batch?.state === 'complete'
                ? 'No relationships found in the searched contexts.'
                : `Results are ${batch?.state ?? 'unavailable'}.`}
            </p>
          )}
        </div>
        {selected && (
          <aside className="hierarchy-preview">
            <strong>{selected.location.name}</strong>
            <span>
              {selected.location.relationship} · {selected.location.contextIds.length} contexts
            </span>
            <pre>{selected.location.preview}</pre>
            <button onClick={() => onOpen(selected.location)}>Open source</button>
            {selected.loading && <p>Loading relationships…</p>}
            {selected.error && (
              <p className="error-message" role="alert">
                {selected.error}
              </p>
            )}
            {selected.result && (
              <>
                <p>
                  {selected.result.state} · {selected.result.searchedContexts}/
                  {selected.result.totalContexts} contexts · {selected.result.locations.length}{' '}
                  relationships
                </p>
                {selected.result.reasons.map((reason) => (
                  <p key={reason}>{reason}</p>
                ))}
                {selected.result.state === 'complete' && !selected.children?.length && (
                  <p>No further relationships.</p>
                )}
              </>
            )}
          </aside>
        )}
      </div>
    </section>
  );
}
