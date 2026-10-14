import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from './Icon';

export type MenuEntry =
  | 'separator'
  | {
      label: string;
      shortcut?: string;
      disabled?: boolean;
      checked?: boolean;
      run?(): void;
      children?: MenuEntry[];
    };

/** IntelliJ-style editor popup: grouped actions, shortcuts, ticks and flyout submenus. */
export function EditorContextMenu({
  x,
  y,
  entries,
  onClose,
}: {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose(): void;
}) {
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest('.editor-context-menu')) onClose();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);
  return <Menu x={x} y={y} entries={entries} onClose={onClose} autoFocus />;
}

function Menu({
  x,
  y,
  entries,
  onClose,
  onBack,
  autoFocus,
}: {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose(): void;
  onBack?(): void;
  autoFocus?: boolean;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<{ index: number; x: number; y: number } | null>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  useEffect(() => {
    // Keep the menu on screen, flipping above or left of the pointer when needed.
    const box = element.current?.getBoundingClientRect();
    if (!box) return;
    setPosition({
      left: Math.max(4, x + box.width > innerWidth ? innerWidth - box.width - 4 : x),
      top: Math.max(4, y + box.height > innerHeight ? innerHeight - box.height - 4 : y),
    });
    if (autoFocus) element.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
  }, [x, y, autoFocus]);
  const items = () => [
    ...(element.current?.querySelectorAll<HTMLElement>(':scope > [role^="menuitem"]') ?? []),
  ];
  function openSubmenu(index: number, target: HTMLElement, focus: boolean) {
    const box = target.getBoundingClientRect();
    setOpen({ index, x: box.right - 2, y: box.top - 5 });
    if (focus)
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLElement>('.editor-context-menu.submenu [role^="menuitem"]')
          ?.focus(),
      );
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    const list = items().filter((item) => !item.hasAttribute('disabled'));
    const current = list.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      list[(current + step + list.length) % list.length]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (onBack) onBack();
      else onClose();
    } else if (event.key === 'ArrowLeft' && onBack) {
      event.preventDefault();
      event.stopPropagation();
      onBack();
    }
  }
  return (
    <>
      <div
        ref={element}
        role="menu"
        className={`editor-context-menu${onBack ? ' submenu' : ''}`}
        style={position}
        onKeyDown={keyDown}
      >
        {entries.map((entry, index) => {
          if (entry === 'separator') return <div key={index} className="menu-separator" />;
          const submenu = !!entry.children;
          return (
            <button
              key={entry.label}
              role={entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
              aria-checked={entry.checked}
              aria-haspopup={submenu || undefined}
              aria-expanded={submenu ? open?.index === index : undefined}
              disabled={entry.disabled}
              onMouseEnter={(event) =>
                submenu ? openSubmenu(index, event.currentTarget, false) : setOpen(null)
              }
              onKeyDown={(event) => {
                if (submenu && (event.key === 'ArrowRight' || event.key === 'Enter')) {
                  event.preventDefault();
                  event.stopPropagation();
                  openSubmenu(index, event.currentTarget, true);
                }
              }}
              onClick={(event) => {
                if (submenu) return openSubmenu(index, event.currentTarget, true);
                onClose();
                entry.run?.();
              }}
            >
              <span className="menu-check" aria-hidden="true">
                {entry.checked && <Icon name="check" />}
              </span>
              <span className="menu-label">{entry.label}</span>
              {entry.shortcut && <kbd>{entry.shortcut}</kbd>}
              {submenu && (
                <span className="menu-arrow">
                  <Icon name="chevron" />
                </span>
              )}
            </button>
          );
        })}
      </div>
      {open && entries[open.index] !== 'separator' && (
        <Menu
          x={open.x}
          y={open.y}
          entries={(entries[open.index] as { children: MenuEntry[] }).children}
          onClose={onClose}
          onBack={() => {
            const index = open.index;
            setOpen(null);
            items()
              .find((_item, at) => at === entriesBefore(entries, index))
              ?.focus();
          }}
        />
      )}
    </>
  );
}

/** Index of an entry among the rendered menu items, which exclude separators. */
const entriesBefore = (entries: MenuEntry[], index: number) =>
  entries.slice(0, index).filter((entry) => entry !== 'separator').length;
