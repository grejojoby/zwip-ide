import { useState } from 'react';
import { scratchTypes, type ScratchType } from '../model/scratch-types';
import { Icon } from './Icon';
import { Modal } from './Modal';

export interface ScratchFile {
  path: string;
  name: string;
  size: number;
  modified: number;
}

/** IntelliJ's New Scratch File popup: filter the file types, Enter creates the first match. */
export function NewScratchDialog({
  onCreate,
  onClose,
}: {
  onCreate(type: ScratchType): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const matches = scratchTypes.filter((type) =>
    `${type.label} ${type.extension}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const selected = Math.min(index, Math.max(0, matches.length - 1));
  return (
    <Modal title="New Scratch File" onClose={onClose}>
      <div className="modal-body scratch-dialog">
        <input
          data-autofocus
          aria-label="Scratch file type"
          placeholder="Type a language or extension"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const step = event.key === 'ArrowDown' ? 1 : -1;
              setIndex((selected + step + matches.length) % Math.max(1, matches.length));
            } else if (event.key === 'Enter' && matches[selected]) {
              event.preventDefault();
              onCreate(matches[selected]);
            }
          }}
        />
        <div role="listbox" aria-label="Scratch file types" className="scratch-types">
          {matches.map((type, position) => (
            <button
              key={type.extension}
              role="option"
              aria-selected={position === selected}
              className={position === selected ? 'selected' : ''}
              onMouseEnter={() => setIndex(position)}
              onClick={() => onCreate(type)}
            >
              <Icon name="file" />
              <span>{type.label}</span>
              <span className="muted">.{type.extension}</span>
            </button>
          ))}
          {!matches.length && <p className="empty-note">No matching file type.</p>}
        </div>
      </div>
    </Modal>
  );
}

/** "Scratches and Consoles" under the project tree: scratch files shared by every project. */
export function ScratchList({
  files,
  active,
  onOpen,
  onDelete,
  onNew,
}: {
  files: ScratchFile[];
  active?: string;
  onOpen(path: string): void;
  onDelete(path: string): void;
  onNew(): void;
}) {
  const [open, setOpen] = useState(true);
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <section className="scratch-list" aria-label="Scratches and Consoles">
      <div className="scratch-heading">
        <button aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <Icon
            name="chevron"
            style={{ width: 10, transform: open ? 'rotate(90deg)' : undefined }}
          />
          Scratches and Consoles
          <span className="muted">{files.length}</span>
        </button>
        <button
          className="icon-button"
          aria-label="New scratch file"
          title="New scratch file"
          onClick={onNew}
        >
          +
        </button>
      </div>
      {open &&
        files.map((file) => (
          <div key={file.path} className={`scratch-row ${file.path === active ? 'selected' : ''}`}>
            <button title={file.path} onClick={() => onOpen(file.path)}>
              <Icon name="file" />
              {file.name}
            </button>
            {confirming === file.path ? (
              <button
                className="scratch-delete"
                onClick={() => {
                  setConfirming(null);
                  onDelete(file.path);
                }}
                onBlur={() => setConfirming(null)}
              >
                Delete
              </button>
            ) : (
              <button
                className="icon-button scratch-delete"
                aria-label={`Delete ${file.name}`}
                title="Delete scratch file"
                onClick={() => setConfirming(file.path)}
              >
                <Icon name="close" />
              </button>
            )}
          </div>
        ))}
    </section>
  );
}
