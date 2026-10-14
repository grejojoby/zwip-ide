import { useMemo, useRef, useState, useEffect } from 'react';
import type { ExcludedDirectory, FileEntry } from '../contracts';
import { buildTree, flattenTree, type TreeEntry, type TreeStatus } from '../model/file-tree';
import { Icon } from './Icon';
const ROW = 27;
export function ProjectTree({
  files,
  directories,
  ignoredFiles = [],
  ignoredDirectories = [],
  excludedDirectories = [],
  root,
  active,
  onOpen,
  onExclude,
}: {
  files: FileEntry[];
  directories?: string[];
  ignoredFiles?: FileEntry[];
  ignoredDirectories?: string[];
  excludedDirectories?: ExcludedDirectory[];
  root: string;
  active?: string;
  onOpen(path: string): void;
  onExclude?(relativePath: string, excluded: boolean): void;
}) {
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState(new Set<string>());
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(700);
  const viewport = useRef<HTMLDivElement>(null);
  const activeRelativePath = active?.startsWith(`${root}/`)
    ? active.slice(root.length + 1)
    : undefined;
  const relative = (path: string) =>
    path.startsWith(`${root}/`) ? path.slice(root.length + 1) : '';
  const relativeDirectories = useMemo(
    () => (directories ?? []).map(relative).filter(Boolean),
    [directories, root],
  );
  const relativeIgnoredDirectories = useMemo(
    () => ignoredDirectories.map(relative).filter(Boolean),
    [ignoredDirectories, root],
  );
  const statuses = useMemo(() => {
    const result = new Map<string, TreeStatus>();
    for (const path of relativeIgnoredDirectories) result.set(path, 'ignored');
    for (const file of ignoredFiles) result.set(file.relativePath, 'ignored');
    for (const item of excludedDirectories) result.set(item.path, 'excluded');
    return result;
  }, [relativeIgnoredDirectories, ignoredFiles, excludedDirectories]);
  const listed = useMemo(() => [...files, ...ignoredFiles], [files, ignoredFiles]);
  const listedDirectories = useMemo(
    () => [
      ...relativeDirectories,
      ...relativeIgnoredDirectories,
      ...excludedDirectories.map((item) => item.path),
    ],
    [relativeDirectories, relativeIgnoredDirectories, excludedDirectories],
  );
  const tree = useMemo(() => buildTree(listed, listedDirectories), [listed, listedDirectories]);
  const entries = useMemo<TreeEntry[]>(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return flattenTree(tree, expanded, 0, statuses);
    const withStatus = (entry: TreeEntry): TreeEntry => {
      const status = statuses.get(entry.id) ?? statuses.get(entry.file?.relativePath ?? '');
      return status ? { ...entry, status } : entry;
    };
    return [
      ...listedDirectories
        .filter((path) => path.toLowerCase().includes(query))
        .map((path) => withStatus({ id: path, name: path, depth: 0, directory: true })),
      ...listed
        .filter((f) => f.relativePath.toLowerCase().includes(query))
        .map((file) =>
          withStatus({
            id: file.path,
            name: file.relativePath,
            depth: 0,
            directory: false,
            file,
          }),
        ),
    ];
  }, [listed, tree, expanded, filter, listedDirectories, statuses]);
  useEffect(() => {
    if (!viewport.current) return;
    const observer = new ResizeObserver(([entry]) => setHeight(entry.contentRect.height));
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (viewport.current) viewport.current.scrollTop = 0;
    setScroll(0);
  }, [filter, files]);
  useEffect(() => {
    if (!activeRelativePath) return;
    const parts = activeRelativePath.split('/');
    const ancestors = parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join('/'));
    setExpanded((current) =>
      ancestors.every((path) => current.has(path)) ? current : new Set([...current, ...ancestors]),
    );
  }, [activeRelativePath]);
  useEffect(() => {
    const target = entries.findIndex((entry) => entry.file?.path === active);
    const element = viewport.current;
    if (!element || target < 0) return;
    const top = target * ROW;
    if (top < element.scrollTop || top + ROW > element.scrollTop + height) {
      element.scrollTop = Math.max(0, top - Math.max(0, height - ROW) / 2);
      setScroll(element.scrollTop);
    }
  }, [active, entries, height]);
  const first = Math.max(0, Math.floor(scroll / ROW) - 8);
  const shown = entries.slice(first, first + Math.ceil(height / ROW) + 16);
  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function openMenu(id: string, x: number, y: number) {
    if (onExclude) setMenu({ id, x, y });
  }
  function moveFocus(index: number) {
    if (!viewport.current) return;
    const next = Math.max(0, Math.min(entries.length - 1, index));
    if (
      next * ROW < viewport.current.scrollTop ||
      (next + 1) * ROW > viewport.current.scrollTop + height
    )
      viewport.current.scrollTop = next * ROW;
    requestAnimationFrame(() =>
      viewport.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.focus(),
    );
  }
  return (
    <>
      <div className="tree-filter">
        <Icon name="search" />
        <input
          aria-label="Filter project files"
          placeholder="Filter files"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div
        ref={viewport}
        className="tree-viewport"
        role="tree"
        aria-label="Project files"
        onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
      >
        <div style={{ height: entries.length * ROW, position: 'relative' }}>
          {shown.map((entry, index) => {
            const selected = entry.file !== undefined && active === entry.file.path;
            return (
              <button
                key={entry.id}
                role="treeitem"
                aria-level={entry.depth + 1}
                aria-selected={selected}
                aria-expanded={entry.directory ? expanded.has(entry.id) : undefined}
                data-index={first + index}
                className={['tree-row', selected && 'selected', entry.status]
                  .filter(Boolean)
                  .join(' ')}
                style={{ top: (first + index) * ROW, paddingLeft: 10 + entry.depth * 14 }}
                title={entry.id}
                onClick={() => (entry.directory ? toggle(entry.id) : onOpen(entry.file!.path))}
                onContextMenu={(e) => {
                  if (!entry.directory || !onExclude) return;
                  e.preventDefault();
                  openMenu(entry.id, e.clientX, e.clientY);
                }}
                onKeyDown={(e) => {
                  if (
                    entry.directory &&
                    (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))
                  ) {
                    e.preventDefault();
                    const box = e.currentTarget.getBoundingClientRect();
                    openMenu(entry.id, box.left + 24, box.bottom);
                    return;
                  }
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    moveFocus(first + index + (e.key === 'ArrowDown' ? 1 : -1));
                  }
                  if (
                    entry.directory &&
                    ((e.key === 'ArrowRight' && !expanded.has(entry.id)) ||
                      (e.key === 'ArrowLeft' && expanded.has(entry.id)))
                  ) {
                    e.preventDefault();
                    toggle(entry.id);
                  }
                }}
              >
                {entry.directory && entry.status !== 'excluded' ? (
                  <Icon
                    name="chevron"
                    style={{
                      width: 10,
                      transform: expanded.has(entry.id) ? 'rotate(90deg)' : undefined,
                    }}
                  />
                ) : (
                  <span className="tree-spacer" />
                )}
                <Icon name={entry.directory ? 'folder' : 'file'} />
                <span>{entry.name}</span>
              </button>
            );
          })}
        </div>
        {!entries.length && <p className="empty-note">No matching files.</p>}
      </div>
      {menu && (
        <div
          role="menu"
          className="tree-context-menu"
          style={{ left: menu.x, top: menu.y }}
          // WebKit does not focus a clicked button, so the mousedown would blur the item and
          // close the menu before its click arrives. Keep focus where it is.
          onMouseDown={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setMenu(null);
          }}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) setMenu(null);
          }}
        >
          {(() => {
            const reason = excludedDirectories.find((item) => item.path === menu.id)?.reason;
            // Built-in exclusions (dependency/build folders, worktrees) cannot be included here.
            const fixed = reason !== undefined && reason !== 'Excluded by you';
            return (
              <button
                role="menuitemcheckbox"
                aria-checked={reason !== undefined}
                disabled={fixed}
                title={fixed ? reason : undefined}
                ref={(element) => element?.focus()}
                onClick={() => {
                  onExclude?.(menu.id, reason === undefined);
                  setMenu(null);
                }}
              >
                <span className="menu-check" aria-hidden="true">
                  {reason !== undefined && <Icon name="check" />}
                </span>
                Exclude from search and indexing
              </button>
            );
          })()}
        </div>
      )}
      <div className="panel-footnote">{files.length.toLocaleString()} workspace files</div>
    </>
  );
}
