import { useEffect, useMemo, useRef, useState } from 'react';
import type { FileEntry } from '../contracts';
import { Modal } from './Modal';
import { Icon } from './Icon';
export function FileSearch({
  files,
  recent,
  onOpen,
  onClose,
}: {
  files: FileEntry[];
  recent: string[];
  onOpen(path: string): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
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
      .slice(0, 100);
  }, [files, query, recent]);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>('[data-highlighted="true"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [index]);
  return (
    <Modal title="Go to file" onClose={onClose}>
      <div className="search-input">
        <Icon name="search" />
        <input
          data-autofocus
          aria-label="Search project files"
          placeholder="File name or path…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((current) =>
                Math.max(
                  0,
                  Math.min(matches.length - 1, current + (e.key === 'ArrowDown' ? 1 : -1)),
                ),
              );
            }
            if (e.key === 'Enter' && matches[index]) onOpen(matches[index].path);
          }}
        />
      </div>
      <div ref={list} className="file-search-results">
        <div className="section-label">{query ? 'Matching files' : 'Recent files'}</div>
        {matches.map((file, item) => (
          <button
            data-highlighted={item === index}
            className={`file-search-row ${item === index ? 'selected' : ''}`}
            key={file.path}
            onClick={() => onOpen(file.path)}
          >
            <Icon name="file" />
            <strong>{file.path.split('/').pop()}</strong>
            <span>{file.relativePath}</span>
          </button>
        ))}
        {!matches.length && (
          <p className="empty-note">
            {query ? 'No matching files.' : 'Open a file or type to search the workspace.'}
          </p>
        )}
      </div>
      <div className="modal-actions">
        <span>↑ ↓ Select · Enter Open · Esc Close</span>
      </div>
    </Modal>
  );
}
