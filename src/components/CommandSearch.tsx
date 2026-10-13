import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './Modal';
import { Icon } from './Icon';
export interface ActionCommand {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  run(): void;
}
export function CommandSearch({
  commands,
  onClose,
}: {
  commands: ActionCommand[];
  onClose(): void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const options = useMemo(
    () =>
      commands.filter(
        (command) =>
          !command.disabled &&
          query
            .toLowerCase()
            .split(/\s+/)
            .every((part) => command.label.toLowerCase().includes(part)),
      ),
    [commands, query],
  );
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>('[data-highlighted="true"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);
  function choose(index: number) {
    const command = options[index];
    if (command) {
      onClose();
      command.run();
    }
  }
  return (
    <Modal title="Find action" onClose={onClose}>
      <div className="search-input">
        <Icon name="search" />
        <input
          data-autofocus
          aria-label="Search actions"
          placeholder="Type an action…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setSelected((index) =>
                Math.max(0, Math.min(options.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1))),
              );
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              choose(selected);
            }
          }}
        />
      </div>
      <div className="file-search-results" ref={list}>
        {options.map((command, index) => (
          <button
            key={command.id}
            data-highlighted={index === selected}
            className={`file-search-row ${index === selected ? 'selected' : ''}`}
            onClick={() => choose(index)}
          >
            <span style={{ color: 'var(--text)', margin: 0, fontSize: 12 }}>{command.label}</span>
            <div className="spacer" />
            <kbd>{command.shortcut}</kbd>
          </button>
        ))}
        {!options.length && <p className="empty-note">No matching actions.</p>}
      </div>
      <div className="modal-actions">
        <span>↑ ↓ Select · Enter Run · Esc Close</span>
      </div>
    </Modal>
  );
}
