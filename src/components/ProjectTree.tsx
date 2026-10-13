import { useMemo, useRef, useState, useEffect } from 'react';
import type { FileEntry } from '../contracts';
import { buildTree, flattenTree, type TreeEntry } from '../model/file-tree';
import { Icon } from './Icon';
const ROW = 27;
export function ProjectTree({
  files,
  directories,
  root,
  active,
  onOpen,
}: {
  files: FileEntry[];
  directories?: string[];
  root: string;
  active?: string;
  onOpen(path: string): void;
}) {
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState(new Set<string>());
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(700);
  const viewport = useRef<HTMLDivElement>(null);
  const activeRelativePath = active?.startsWith(`${root}/`)
    ? active.slice(root.length + 1)
    : undefined;
  const relativeDirectories = useMemo(
    () =>
      (directories ?? [])
        .filter((path) => path.startsWith(`${root}/`))
        .map((path) => path.slice(root.length + 1)),
    [directories, root],
  );
  const tree = useMemo(() => buildTree(files, relativeDirectories), [files, relativeDirectories]);
  const entries = useMemo<TreeEntry[]>(
    () =>
      filter.trim()
        ? [
            ...relativeDirectories
              .filter((path) => path.toLowerCase().includes(filter.toLowerCase()))
              .map((path) => ({ id: path, name: path, depth: 0, directory: true })),
            ...files
              .filter((f) => f.relativePath.toLowerCase().includes(filter.toLowerCase()))
              .map((file) => ({
                id: file.path,
                name: file.relativePath,
                depth: 0,
                directory: false,
                file,
              })),
          ]
        : flattenTree(tree, expanded),
    [files, tree, expanded, filter, relativeDirectories],
  );
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
          {shown.map((entry, index) => (
            <button
              key={entry.id}
              role="treeitem"
              aria-level={entry.depth + 1}
              aria-selected={active === entry.file?.path}
              aria-expanded={entry.directory ? expanded.has(entry.id) : undefined}
              data-index={first + index}
              className={`tree-row ${active === entry.file?.path ? 'selected' : ''}`}
              style={{ top: (first + index) * ROW, paddingLeft: 10 + entry.depth * 14 }}
              title={entry.id}
              onClick={() => (entry.directory ? toggle(entry.id) : onOpen(entry.file!.path))}
              onKeyDown={(e) => {
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
              {entry.directory ? (
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
          ))}
        </div>
        {!entries.length && <p className="empty-note">No matching files.</p>}
      </div>
      <div className="panel-footnote">{files.length.toLocaleString()} workspace files</div>
    </>
  );
}
