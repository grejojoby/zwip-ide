import { useEffect, useRef, useState } from 'react';
import type { SourceLocation } from '../contracts';
import { Modal } from './Modal';
export function TargetChooser({
  locations,
  onChoose,
  onClose,
}: {
  locations: SourceLocation[];
  onChoose(location: SourceLocation): void;
  onClose(): void;
}) {
  const [selected, setSelected] = useState(0);
  const current = locations[selected];
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`#target-${selected}`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);
  return (
    <Modal title="Choose a target" onClose={onClose} wide>
      <div
        className="target-chooser"
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setSelected(
              (index) =>
                (index + (event.key === 'ArrowDown' ? 1 : -1) + locations.length) %
                locations.length,
            );
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            onChoose(current);
          }
        }}
      >
        <div
          ref={list}
          className="target-list"
          data-autofocus
          role="listbox"
          aria-label="Navigation targets"
          aria-activedescendant={`target-${selected}`}
          tabIndex={0}
          autoFocus
        >
          {locations.map((location, index) => (
            <div
              id={`target-${index}`}
              role="option"
              aria-selected={selected === index}
              key={`${location.path}:${index}`}
              className={`target-option ${selected === index ? 'selected' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setSelected(index)}
              onDoubleClick={() => onChoose(location)}
            >
              <strong>{location.name || location.path.split('/').pop()}</strong>
              <span>
                {location.path}:{location.range.start.line + 1}
              </span>
            </div>
          ))}
        </div>
        <div className="target-preview">
          <span>{current.relationship}</span>
          <pre>{current.preview || current.name}</pre>
          <p>{current.contextIds.join(', ')}</p>
        </div>
      </div>
      <div className="modal-actions">
        <span>↑ ↓ Select · Enter Open · Esc Close</span>
        <button className="primary" onClick={() => onChoose(current)}>
          Open target
        </button>
      </div>
    </Modal>
  );
}
