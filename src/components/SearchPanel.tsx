import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { BuildContext, SearchMatch } from '../contracts';
import { FileIcon } from './FileIcon';
import { Icon } from './Icon';
import './search-panel.css';

/** Literal, case-sensitive matches, just like workspace.search. Keep long lines near the hit. */
function MatchPreview({ text, query }: { text: string; query: string }) {
  const first = query ? text.indexOf(query) : -1;
  const indent = Math.min(Math.max(0, first), text.length - text.trimStart().length);
  const start = Math.max(indent, first - 24);
  const excerpt = text.slice(start, Math.max(start + 240, first + query.length + 60));
  return (
    <code className="find-code">
      {start > indent && '…'}
      {query
        ? excerpt.split(query).map((part, index) => (
            <Fragment key={index}>
              {index > 0 && <mark>{query}</mark>}
              {part}
            </Fragment>
          ))
        : excerpt}
      {start + excerpt.length < text.length && '…'}
    </code>
  );
}

export function SearchPanel({
  query,
  resultQuery,
  matches,
  searching,
  error,
  workspaceRoot,
  directory,
  focusRequest = 0,
  resultDirectory,
  directories = [],
  modules = [],
  onDirectoryChange,
  onQueryChange,
  onSearch,
  onOpen,
}: {
  query: string;
  resultQuery: string | null;
  matches: SearchMatch[];
  searching: boolean;
  error: string;
  workspaceRoot: string;
  directory: string;
  focusRequest?: number;
  resultDirectory: string;
  directories?: string[];
  modules?: Pick<BuildContext, 'root' | 'language'>[];
  onDirectoryChange(directory: string): void;
  onQueryChange(query: string): void;
  onSearch(): void;
  onOpen(match: SearchMatch, character: number): void;
}) {
  const directoryListId = useId();
  const queryInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusRequest) queryInput.current?.focus();
  }, [focusRequest]);
  const suggestions = useMemo(() => {
    const root = workspaceRoot.replace(/\/+$/, '');
    const relative = (path: string) =>
      path === root ? '.' : path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
    const paths = new Map<string, string>();
    for (const path of directories) {
      const value = relative(path);
      if (value) paths.set(value, 'Directory');
    }
    for (const module of modules) {
      const value = relative(module.root);
      if (value) paths.set(value, `${module.language} module`);
    }
    return [...paths].sort(([a], [b]) => a.localeCompare(b));
  }, [workspaceRoot, directories, modules]);
  const groups = useMemo(() => {
    const files = new Map<string, SearchMatch[]>();
    for (const match of matches) {
      const lines = files.get(match.path) ?? [];
      lines.push(match);
      files.set(match.path, lines);
    }
    return [...files];
  }, [matches]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const relativePath = (path: string) => {
    const prefix = `${workspaceRoot.replace(/\/+$/, '')}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
  };
  const count = matches.length.toLocaleString('en-US');
  const stale = resultQuery !== null && (query !== resultQuery || directory !== resultDirectory);
  return (
    <section className="search-panel find-panel" aria-label="Find in files" aria-busy={searching}>
      <form
        className="find-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          if (query.trim() && !searching) onSearch();
        }}
      >
        <label className="find-input">
          <Icon name="search" />
          <input
            autoFocus
            ref={queryInput}
            aria-label="Search text in workspace"
            placeholder="Find in files…"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
          <span title="Literal, case-sensitive text search">Aa</span>
        </label>
        <button className="find-submit" disabled={searching || !query.trim()}>
          {searching ? 'Searching…' : 'Find'}
        </button>
        <div className="find-directory-scope">
          <label>
            <span>Directory / module</span>
            <input
              aria-label="Directory / module"
              list={directoryListId}
              value={directory}
              placeholder="Whole workspace"
              onChange={(event) => onDirectoryChange(event.target.value)}
            />
          </label>
          <datalist id={directoryListId}>
            {suggestions.map(([path, label]) => (
              <option key={path} value={path} label={label} />
            ))}
          </datalist>
          <button
            type="button"
            aria-label="Search whole workspace"
            disabled={!directory}
            onClick={() => onDirectoryChange('')}
          >
            Whole workspace
          </button>
          <span className="find-scope">Includes nested directories · saved files</span>
        </div>
      </form>
      <div className="find-summary">
        <span role="status">
          {searching
            ? directory
              ? 'Searching directory…'
              : 'Searching workspace…'
            : error
              ? 'Search failed'
              : resultQuery === null
                ? 'Find in files'
                : `${matches.length >= 1000 ? 'First ' : ''}${count} matching line${matches.length === 1 ? '' : 's'} in ${groups.length} file${groups.length === 1 ? '' : 's'}`}
        </span>
        {resultQuery !== null && !searching && !error && (
          <span className="find-scope">Results in {resultDirectory || 'whole workspace'}</span>
        )}
        {stale && !searching && <span className="find-stale">Press Enter to update results.</span>}
        <div className="spacer" />
        <button
          className="icon-button"
          aria-label="Expand all files"
          title="Expand all files"
          disabled={!groups.length || searching}
          onClick={() => setCollapsed(new Set())}
        >
          <Icon name="chevron" style={{ transform: 'rotate(90deg)' }} />
        </button>
        <button
          className="icon-button"
          aria-label="Collapse all files"
          title="Collapse all files"
          disabled={!groups.length || searching}
          onClick={() => setCollapsed(new Set(groups.map(([path]) => path)))}
        >
          <Icon name="chevron" style={{ transform: 'rotate(-90deg)' }} />
        </button>
      </div>
      {!searching && matches.length >= 1000 && (
        <p className="find-limit">
          Search stopped at 1,000 matching lines. Refine your query to see more specific results.
        </p>
      )}
      <div
        className="results-list find-list"
        role="region"
        aria-label="Search results"
        onKeyDown={(event) => {
          if (
            !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) ||
            event.altKey ||
            event.metaKey ||
            event.ctrlKey
          )
            return;
          const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
          const index = rows.indexOf(event.target as HTMLButtonElement);
          if (index < 0) return;
          event.preventDefault();
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? rows.length - 1
                : Math.max(
                    0,
                    Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)),
                  );
          rows[next]?.focus();
          rows[next]?.scrollIntoView?.({ block: 'nearest' });
        }}
      >
        {!searching &&
          !error &&
          groups.map(([path, lines]) => {
            const relative = relativePath(path);
            const slash = relative.lastIndexOf('/');
            const expanded = !collapsed.has(path);
            return (
              <div className="find-file-group" key={path}>
                <button
                  className="find-file"
                  aria-expanded={expanded}
                  aria-label={`${relative}, ${lines.length} matching line${lines.length === 1 ? '' : 's'}`}
                  title={relative}
                  onClick={() =>
                    setCollapsed((previous) => {
                      const next = new Set(previous);
                      if (next.has(path)) next.delete(path);
                      else next.add(path);
                      return next;
                    })
                  }
                >
                  <Icon
                    name="chevron"
                    style={{ transform: expanded ? 'rotate(90deg)' : undefined }}
                  />
                  <FileIcon path={path} />
                  <strong>{relative.slice(slash + 1)}</strong>
                  <span className="find-directory">
                    {slash >= 0 ? relative.slice(0, slash) : ''}
                  </span>
                  <span className="find-count">{lines.length}</span>
                </button>
                {expanded &&
                  lines.map((match, index) => (
                    <button
                      className="find-line"
                      key={`${match.line}:${index}`}
                      title={match.text}
                      aria-label={`${relative}:${match.line + 1}: ${resultQuery} match`}
                      onClick={() =>
                        onOpen(
                          match,
                          Math.max(0, resultQuery ? match.text.indexOf(resultQuery) : 0),
                        )
                      }
                    >
                      <span className="find-line-number">{match.line + 1}</span>
                      <MatchPreview text={match.text} query={resultQuery ?? ''} />
                    </button>
                  ))}
              </div>
            );
          })}
        {error ? (
          <div className="find-empty" role="alert">
            <strong>Couldn’t search workspace</strong>
            <p>{error}</p>
          </div>
        ) : (
          !searching &&
          !matches.length && (
            <div className="find-empty">
              <Icon name="search" />
              <strong>
                {resultQuery === null ? 'Find text across your workspace' : 'No matching lines'}
              </strong>
              <p>
                {resultQuery === null ? (
                  'Enter text above, optionally choose a directory or module, and press Enter to search saved files.'
                ) : (
                  <>
                    No results for <q>{resultQuery}</q>. Try a different term or check
                    capitalization.
                  </>
                )}
              </p>
            </div>
          )
        )}
      </div>
    </section>
  );
}
