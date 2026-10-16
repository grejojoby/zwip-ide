import { useMemo, useRef, useState, useEffect } from 'react';
import type { ExcludedDirectory, FileEntry } from '../contracts';
import { buildTree, flattenTree, type TreeEntry, type TreeStatus } from '../model/file-tree';
import { FileIcon } from './FileIcon';
import { Icon } from './Icon';
import { EditorContextMenu, type MenuEntry } from './EditorContextMenu';
export type ProjectAction =
  | 'file'
  | 'directory'
  | 'rename'
  | 'copy'
  | 'trash'
  | 'restore'
  | 'copyPath'
  | 'copyRelativePath'
  | 'reveal'
  | 'refactor'
  | 'format';
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
  onAction,
}: {
  files: FileEntry[];
  directories?: string[];
  ignoredFiles?: FileEntry[];
  ignoredDirectories?: string[];
  excludedDirectories?: ExcludedDirectory[];
  root: string;
  active?: string;
  onOpen(path: string): void;
  onAction?(action: ProjectAction, path: string, directory: boolean): void;
  onExclude?(relativePath: string, excluded: boolean): void;
}) {
  const [menu, setMenu] = useState<{
    entry: TreeEntry;
    x: number;
    y: number;
    trigger: HTMLElement;
  } | null>(null);
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
  // Reveal a file once when it becomes active, not again whenever the rows change (expanding a
  // folder must not jump back to it). The reveal waits until its ancestors are expanded.
  const reveal = useRef(active);
  useEffect(() => {
    reveal.current = active;
  }, [active]);
  useEffect(() => {
    if (!reveal.current) return;
    const target = entries.findIndex((entry) => entry.file?.path === reveal.current);
    const element = viewport.current;
    if (!element || target < 0) return;
    reveal.current = undefined;
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
  function openMenu(entry: TreeEntry, x: number, y: number, trigger: HTMLElement) {
    if (onAction || (entry.directory && onExclude)) setMenu({ entry, x, y, trigger });
  }
  function closeMenu() {
    menu?.trigger.focus();
    setMenu(null);
  }
  function menuEntries(): MenuEntry[] {
    if (!menu) return [];
    const { entry } = menu;
    const path = entry.directory ? `${root}/${entry.id}` : entry.file!.path;
    const action = (label: string, kind: ProjectAction): MenuEntry => ({
      label,
      run: () => onAction?.(kind, path, entry.directory),
    });
    const items: MenuEntry[] = [];
    if (onAction) {
      if (!entry.directory) items.push({ label: 'Open', run: () => onOpen(path) }, 'separator');
      items.push(action('New file…', 'file'), action('New folder…', 'directory'));
      if (!entry.directory)
        items.push(
          'separator',
          action('Rename or move…', 'rename'),
          action('Refactor / code actions…', 'refactor'),
          action('Format file', 'format'),
          action('Copy file…', 'copy'),
          action('Delete…', 'trash'),
        );
      items.push(
        'separator',
        action('Copy path', 'copyPath'),
        action('Copy relative path', 'copyRelativePath'),
        action('Show in Finder', 'reveal'),
        'separator',
        action('Recover trashed files…', 'restore'),
      );
    }
    if (entry.directory && onExclude) {
      const reason = excludedDirectories.find((item) => item.path === entry.id)?.reason;
      if (items.length) items.push('separator');
      items.push({
        label: 'Exclude from search and indexing',
        checked: reason !== undefined,
        disabled: reason !== undefined && reason !== 'Excluded by you',
        run: () => onExclude(entry.id, reason === undefined),
      });
    }
    return items;
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
                  if (!onAction && (!entry.directory || !onExclude)) return;
                  e.preventDefault();
                  openMenu(entry, e.clientX, e.clientY, e.currentTarget);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                    e.preventDefault();
                    const box = e.currentTarget.getBoundingClientRect();
                    openMenu(entry, box.left + 24, box.bottom, e.currentTarget);
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
                {entry.directory ? <Icon name="folder" /> : <FileIcon path={entry.id} />}
                <span>{entry.name}</span>
              </button>
            );
          })}
        </div>
        {!entries.length && <p className="empty-note">No matching files.</p>}
      </div>
      {menu && (
        <EditorContextMenu x={menu.x} y={menu.y} entries={menuEntries()} onClose={closeMenu} />
      )}
      <div className="panel-footnote">{files.length.toLocaleString()} workspace files</div>
    </>
  );
}
