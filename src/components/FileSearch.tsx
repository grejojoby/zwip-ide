import { useEffect, useMemo, useRef, useState } from 'react';
import type { FileEntry, NavigationBatch, Position, SourceLocation } from '../contracts';
import { asError } from '../model/document-session';
import { Modal } from './Modal';
import { Icon } from './Icon';
import type { ActionCommand } from './CommandSearch';
export function FileSearch({
  files,
  recent,
  onOpen,
  onClose,
  onSearch,
  commands,
}: {
  files: FileEntry[];
  recent: string[];
  onOpen(path: string, position?: Position, sourceContextId?: string, end?: Position): void;
  onClose(): void;
  /** Adds language-provider functions, types and package declarations to file results. */
  onSearch?(query: string, signal: AbortSignal): Promise<NavigationBatch>;
  commands?: ActionCommand[];
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [batch, setBatch] = useState<NavigationBatch | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const search = useRef(onSearch);
  search.current = onSearch;
  useEffect(() => {
    const controller = new AbortController();
    setBatch(null);
    setError('');
    setLoading(!!query.trim() && !!search.current);
    if (!query.trim() || !search.current) return () => controller.abort();
    const timer = setTimeout(() => {
      void search.current!(query, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) setBatch(result);
        })
        .catch((e: unknown) => {
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
  const matches = useMemo(() => {
    if (!query.trim())
      return recent
        .map((path) => files.find((file) => file.path === path))
        .filter((file): file is FileEntry => !!file)
        .slice(0, 100);
    const parts = query.toLowerCase().split(/\s+/).filter(Boolean);
    return files
      .filter((file) => parts.every((part) => file.relativePath.toLowerCase().includes(part)))
      .sort((a, b) => a.relativePath.length - b.relativePath.length)
      .slice(0, onSearch ? 30 : 100);
  }, [files, query, recent, onSearch]);
  const symbols = batch?.locations ?? [];
  const parts = query.toLowerCase().split(/\s+/).filter(Boolean);
  const actions =
    commands?.filter(
      (command) =>
        !command.disabled && parts.every((part) => command.label.toLowerCase().includes(part)),
    ) ?? [];
  const fileStart = actions.length;
  const symbolStart = fileStart + matches.length;
  const count = symbolStart + symbols.length;
  function chooseAction(command: ActionCommand) {
    onClose();
    command.run();
  }
  function chooseSymbol(location: SourceLocation) {
    onOpen(location.path, location.range.start, location.contextIds[0], location.range.end);
  }
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>('[data-highlighted="true"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [index, count]);
  return (
    <Modal title={onSearch || commands ? 'Search everywhere' : 'Go to file'} onClose={onClose}>
      <div className="search-input">
        <Icon name="search" />
        <input
          data-autofocus
          role="combobox"
          aria-expanded="true"
          aria-controls="file-search-options"
          aria-activedescendant={count ? `file-search-option-${index}` : undefined}
          aria-autocomplete="list"
          aria-label={
            commands
              ? 'Search files, symbols, settings and commands'
              : onSearch
                ? 'Search files, functions and packages'
                : 'Search project files'
          }
          placeholder={
            commands
              ? 'File, function, package, setting or command…'
              : onSearch
                ? 'File, function, type or package name…'
                : 'File name or path…'
          }
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setBatch(null);
            setError('');
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((current) =>
                Math.max(0, Math.min(count - 1, current + (e.key === 'ArrowDown' ? 1 : -1))),
              );
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              if (actions[index]) chooseAction(actions[index]);
              else if (matches[index - fileStart]) onOpen(matches[index - fileStart].path);
              else if (symbols[index - symbolStart]) chooseSymbol(symbols[index - symbolStart]);
            }
          }}
        />
      </div>
      <div
        ref={list}
        id="file-search-options"
        role="listbox"
        aria-label="Search results"
        aria-busy={loading}
        className="file-search-results"
      >
        {commands && <div className="section-label">Settings & commands</div>}
        {actions.map((command, item) => (
          <button
            id={`file-search-option-${item}`}
            role="option"
            aria-selected={item === index}
            data-highlighted={item === index}
            className={`file-search-row ${item === index ? 'selected' : ''}`}
            key={`action:${command.id}`}
            onClick={() => chooseAction(command)}
            onMouseEnter={() => setIndex(item)}
          >
            <Icon name="terminal" />
            <strong>{command.label}</strong>
            <span>
              <kbd>{command.shortcut}</kbd>
            </span>
          </button>
        ))}
        {commands && !actions.length && (
          <p className="empty-note">No matching settings or commands.</p>
        )}
        <div className="section-label">{query ? 'Matching files' : 'Recent files'}</div>
        {matches.map((file, item) => (
          <button
            id={`file-search-option-${fileStart + item}`}
            role="option"
            aria-selected={fileStart + item === index}
            data-highlighted={fileStart + item === index}
            className={`file-search-row ${fileStart + item === index ? 'selected' : ''}`}
            key={file.path}
            onClick={() => onOpen(file.path)}
            onMouseEnter={() => setIndex(fileStart + item)}
          >
            <Icon name="file" />
            <strong>{file.path.split('/').pop()}</strong>
            <span>{file.relativePath}</span>
          </button>
        ))}
        {onSearch && query.trim() && (
          <div className="section-label">Functions, types & packages</div>
        )}
        {symbols.map((location, item) => (
          <button
            id={`file-search-option-${symbolStart + item}`}
            role="option"
            aria-selected={symbolStart + item === index}
            data-highlighted={symbolStart + item === index}
            className={`file-search-row ${symbolStart + item === index ? 'selected' : ''}`}
            key={`${location.path}:${location.range.start.line}:${location.range.start.character}:${item}`}
            onClick={() => chooseSymbol(location)}
            onMouseEnter={() => setIndex(symbolStart + item)}
            title={`${location.relationship} · ${location.path}:${location.range.start.line + 1}`}
          >
            <Icon name={location.relationship === 'package' ? 'package' : 'arrow'} />
            <strong>{location.name}</strong>
            <span>
              {location.path}:{location.range.start.line + 1}
            </span>
          </button>
        ))}
        {onSearch && query.trim() && !symbols.length && (
          <p className="empty-note" role="status">
            {loading
              ? 'Searching functions, types and packages…'
              : batch?.state === 'complete'
                ? 'No matching symbols.'
                : 'Symbol search is incomplete. See details below.'}
          </p>
        )}
        {!matches.length && (
          <p className="empty-note">
            {query ? 'No matching files.' : 'Open a file or type to search the workspace.'}
          </p>
        )}
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
            ? `${batch.state} · ${batch.searchedContexts}/${batch.totalContexts} contexts · `
            : ''}
          ↑ ↓ Select · Enter {actions[index] ? 'Run' : 'Open'} · Esc Close
        </span>
      </div>
    </Modal>
  );
}
