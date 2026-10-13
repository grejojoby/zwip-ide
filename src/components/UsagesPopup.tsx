import { useEffect, useRef, useState } from 'react';
import type { NavigationBatch, Position, SourceLocation } from '../contracts';
import { CodePreview } from '../editor/highlight';
import { Icon } from './Icon';
import { UsagePreview } from './UsagePreview';

export interface PopupAnchor {
  /** Left edge and bottom of the caret line, in viewport pixels. */
  left: number;
  bottom: number;
  /** Top of the caret line, used when there is no room below. */
  top: number;
}

/** Workspace-relative folder for a usage: first and last folders, with … between when longer. */
export function shortDirectory(path: string, root = ''): string {
  const relative =
    root && path.startsWith(`${root.replace(/\/+$/, '')}/`)
      ? path.slice(root.replace(/\/+$/, '').length + 1)
      : path.replace(/^\/+/, '');
  const folders = relative.split('/').slice(0, -1);
  return folders.length > 2 ? `${folders[0]}/…/${folders.at(-1)}` : folders.join('/');
}

const GAP = 6;
// Room for a few usage rows plus the code preview.
const MIN_HEIGHT = 300;

/** IntelliJ-style "Show Usages" popup, placed just below the line it was invoked from. */
export function UsagesPopup({
  anchor,
  symbol,
  workspaceRoot,
  batch,
  loading,
  dark,
  loadPreview,
  onNavigate,
  onOpen,
  onDock,
  onClose,
}: {
  anchor: PopupAnchor;
  symbol: string;
  /** Workspace root, so paths are shown relative to it. */
  workspaceRoot?: string;
  batch: NavigationBatch | null;
  loading: boolean;
  dark: boolean;
  /** Buffer text for the code preview below the list. */
  loadPreview(path: string): Promise<string>;
  /** ⌘-click inside the preview: navigate as the editor would; results open in the editor. */
  onNavigate(path: string, position: Position): void;
  onOpen(location: SourceLocation): void;
  onDock(): void;
  onClose(): void;
}) {
  const [selected, setSelected] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const locations = batch?.locations ?? [];
  const below = window.innerHeight - anchor.bottom - GAP * 2;
  const placeBelow = below >= MIN_HEIGHT || below >= anchor.top;
  const width = Math.min(760, window.innerWidth - 24);
  const style = {
    left: Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12)),
    width,
    ...(placeBelow
      ? { top: anchor.bottom + GAP, maxHeight: below }
      : { bottom: window.innerHeight - anchor.top + GAP, maxHeight: anchor.top - GAP * 2 }),
  };

  useEffect(() => {
    list.current?.focus();
    const outside = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, []);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${selected}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);

  const count = locations.length;
  return (
    <div
      ref={root}
      className="usages-popup"
      role="dialog"
      aria-label={`Usages of ${symbol}`}
      style={style}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && count) {
          event.preventDefault();
          setSelected((at) => (at + (event.key === 'ArrowDown' ? 1 : count - 1)) % count);
        } else if (event.key === 'Enter' && locations[selected]) {
          event.preventDefault();
          onOpen(locations[selected]);
        }
      }}
    >
      <div className="usages-popup-header">
        <strong>
          Usages of <code>{symbol}</code>
        </strong>
        <span className="muted">
          {loading ? `Searching… ${count} found` : `${count} usage${count === 1 ? '' : 's'}`}
          {batch && ` · ${batch.searchedContexts}/${batch.totalContexts} contexts`}
        </span>
        {batch && !loading && batch.state !== 'complete' && (
          <span className="state-badge warning">{batch.state}</span>
        )}
        <span className="spacer" />
        <button
          className="icon-button"
          title="Open in Find tool window"
          aria-label="Dock to bottom panel"
          onClick={onDock}
        >
          <svg
            className="icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          >
            <path d="M3 4h18v16H3zM3 14h18" />
          </svg>
        </button>
        <button className="icon-button" aria-label="Close usages" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {batch?.reasons.map((reason) => (
        <div key={reason} className="inline-notice">
          {reason}
        </div>
      ))}
      <div
        ref={list}
        className="usages-popup-list"
        role="listbox"
        aria-label="Usages"
        aria-activedescendant={count ? `usage-${selected}` : undefined}
        tabIndex={0}
      >
        {locations.map((location, index) => (
          <div
            key={`${location.path}:${location.range.start.line}:${location.range.start.character}:${index}`}
            id={`usage-${index}`}
            data-index={index}
            role="option"
            aria-selected={index === selected}
            className="usages-popup-row"
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setSelected(index)}
            onClick={() => onOpen(location)}
          >
            <CodePreview path={location.path} text={(location.preview || location.name).trim()} />
            <span className="usages-popup-file" title={location.path}>
              {shortDirectory(location.path, workspaceRoot) && (
                <span className="usages-popup-dir">
                  {shortDirectory(location.path, workspaceRoot)}/
                </span>
              )}
              {location.path.split('/').pop()}:{location.range.start.line + 1}
            </span>
          </div>
        ))}
        {!loading && !count && (
          <p className="empty-note">
            {batch?.state === 'complete'
              ? 'No usages in the searched contexts.'
              : `No usages available. Search coverage is ${batch?.state ?? 'unknown'}.`}
          </p>
        )}
      </div>
      {locations[selected] && (
        <UsagePreview
          location={locations[selected]}
          dark={dark}
          load={loadPreview}
          onNavigate={onNavigate}
        />
      )}
    </div>
  );
}
