import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { RunConfiguration } from '../model/run-configurations';
import { Icon } from './Icon';

export function RunConfigurationSelector({
  configurations,
  selectedId,
  disabled = false,
  onSelect,
  onManage,
}: {
  configurations: RunConfiguration[];
  selectedId: string | null;
  disabled?: boolean;
  onSelect(id: string | null): void;
  onManage(): void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef({ text: '', time: 0 });
  const menuId = useId();
  const selected = configurations.find((config) => config.id === selectedId);
  const choices = [
    { id: null, name: 'Workspace command…', detail: 'Enter a command in Run' },
    ...configurations.map((config) => ({
      id: config.id,
      name: config.name,
      detail: config.workingDirectory === '.' ? 'Workspace root' : config.workingDirectory,
    })),
  ];

  useEffect(() => {
    if (!open) return;
    if (disabled) {
      setOpen(false);
      return;
    }
    search.current = { text: '', time: 0 };
    menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const dismiss = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const blur = () => setOpen(false);
    window.addEventListener('mousedown', dismiss);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('mousedown', dismiss);
      window.removeEventListener('blur', blur);
    };
  }, [open, disabled]);

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Tab') {
      close();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    const items = [
      ...(menu.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? []),
    ];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    if (event.key === 'ArrowDown') next = items[(index + 1) % items.length];
    else if (event.key === 'ArrowUp') next = items[(index - 1 + items.length) % items.length];
    else if (event.key === 'Home') next = items[0];
    else if (event.key === 'End') next = items.at(-1);
    else if (
      event.key.length === 1 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      event.key !== ' '
    ) {
      const now = Date.now();
      const previous = now - search.current.time < 700 ? search.current.text : '';
      const text = (previous + event.key).toLocaleLowerCase();
      search.current = { text, time: now };
      const prefix = [...text].every((letter) => letter === text[0]) ? text[0] : text;
      next = [...items.slice(index + 1), ...items.slice(0, index + 1)].find((item) =>
        item.dataset.label?.toLocaleLowerCase().startsWith(prefix),
      );
    } else return;
    event.preventDefault();
    event.stopPropagation();
    next?.focus();
  }

  return (
    <div
      className="run-selector"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="run-selector-trigger"
        aria-label="Run configuration"
        aria-describedby={`${menuId}-selected`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={selected?.name ?? 'Choose a run configuration'}
        value={selected?.id ?? ''}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Icon name={selected ? 'play' : 'terminal'} />
        <span id={`${menuId}-selected`} className={selected ? undefined : 'muted'}>
          {selected?.name ?? 'Workspace command…'}
        </span>
        <Icon name="chevron" />
      </button>
      {open && !disabled && (
        <div
          id={menuId}
          ref={menu}
          className="run-selector-menu"
          role="menu"
          aria-label="Run configurations"
          onKeyDown={keyDown}
        >
          <p className="run-selector-heading">Run configurations</p>
          <div className="run-selector-options" role="group">
            {choices.map((choice, index) => (
              <button
                key={choice.id === null ? 'workspace-command' : `configuration-${choice.id}`}
                type="button"
                role="menuitemradio"
                tabIndex={-1}
                aria-label={choice.name}
                title={`${choice.name}\n${choice.detail}`}
                aria-describedby={`${menuId}-${index}`}
                aria-checked={choice.id === (selected?.id ?? null)}
                data-label={choice.name}
                data-configuration-id={choice.id ?? ''}
                onClick={() => {
                  close();
                  onSelect(choice.id);
                }}
              >
                <Icon name={choice.id ? 'play' : 'terminal'} />
                <span className="run-selector-option-text">
                  <span>{choice.name}</span>
                  <span id={`${menuId}-${index}`} className="run-selector-detail">
                    {choice.detail}
                  </span>
                </span>
                {choice.id === (selected?.id ?? null) && <Icon name="check" />}
              </button>
            ))}
            {!configurations.length && (
              <p className="run-selector-empty">No saved configurations yet.</p>
            )}
          </div>
          <div className="run-selector-footer" role="group">
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              data-label="Edit configurations…"
              onClick={() => {
                close();
                onManage();
              }}
            >
              Edit configurations…
              <Icon name="chevron" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
