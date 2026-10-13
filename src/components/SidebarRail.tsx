import { useEffect, useState, type DragEvent } from 'react';
import { sidebarLabels, type SidebarSide, type SidebarTool } from '../model/sidebar-layout';
import { Icon, type IconName } from './Icon';
import { Modal } from './Modal';
import './sidebar-rail.css';

const dragMime = 'application/x-zwip-sidebar-tool';
const icons: Record<SidebarTool, IconName> = {
  project: 'folder',
  git: 'git',
  database: 'database',
  http: 'http',
};
// The in-memory token restricts drops to a drag started in this application window.
let localDrag: { tool: SidebarTool; side: SidebarSide; token: string } | null = null;
type Move = (tool: SidebarTool, side: SidebarSide) => void;

function moveAndFocus(tool: SidebarTool, side: SidebarSide, onMove: Move) {
  onMove(tool, side);
  requestAnimationFrame(() => {
    if (document.querySelector('dialog[open]')) return;
    document
      .querySelector<HTMLButtonElement>(
        `nav[data-sidebar-side="${side}"] button[data-sidebar-tool="${tool}"]`,
      )
      ?.focus();
  });
}

function MoveActions({
  tool,
  side,
  disabled,
  onMove,
}: {
  tool: SidebarTool;
  side: SidebarSide;
  disabled?: boolean;
  onMove: Move;
}) {
  return (
    <div className="sidebar-move-actions">
      {(['left', 'right'] as const).map((destination) => (
        <button
          key={destination}
          type="button"
          data-autofocus={destination !== side ? '' : undefined}
          disabled={disabled || destination === side}
          onClick={() => onMove(tool, destination)}
        >
          Move to {destination} sidebar
        </button>
      ))}
    </div>
  );
}

function MoveDialog({
  tool,
  side,
  disabled,
  onMove,
  onClose,
}: {
  tool: SidebarTool;
  side: SidebarSide;
  disabled?: boolean;
  onMove: Move;
  onClose(): void;
}) {
  return (
    <Modal title={`Move ${sidebarLabels[tool]}`} onClose={onClose}>
      <div className="modal-body">
        <p>Choose which sidebar holds {sidebarLabels[tool]}.</p>
        <MoveActions
          tool={tool}
          side={side}
          disabled={disabled}
          onMove={(moved, destination) => {
            onClose();
            moveAndFocus(moved, destination, onMove);
          }}
        />
      </div>
      <div className="modal-actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}

export function SidebarMoveButton({
  tool,
  side,
  onMove,
  disabled = false,
}: {
  tool: SidebarTool;
  side: SidebarSide;
  onMove: Move;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="icon-button sidebar-move-button"
        aria-label={`Move ${sidebarLabels[tool]}`}
        title={`Move ${sidebarLabels[tool]}`}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        ⋯
      </button>
      {open && (
        <MoveDialog
          tool={tool}
          side={side}
          disabled={disabled}
          onMove={onMove}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

export function SidebarRail({
  side,
  tools,
  active,
  onToggle,
  onMove,
  disabled = false,
}: {
  side: SidebarSide;
  tools: SidebarTool[];
  active: SidebarTool | null;
  onToggle(tool: SidebarTool): void;
  onMove: Move;
  disabled?: boolean;
}) {
  const [moving, setMoving] = useState<SidebarTool | null>(null);
  const [arranging, setArranging] = useState(false);
  const [dropTarget, setDropTarget] = useState(false);
  useEffect(() => {
    const reset = () => {
      localDrag = null;
      setDropTarget(false);
    };
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape') reset();
    };
    window.addEventListener('dragend', reset);
    window.addEventListener('keydown', cancel);
    return () => {
      window.removeEventListener('dragend', reset);
      window.removeEventListener('keydown', cancel);
      if (localDrag?.side === side) localDrag = null;
    };
  }, [side]);

  function accepts(event: DragEvent) {
    return (
      !disabled &&
      localDrag &&
      localDrag.side !== side &&
      Array.from(event.dataTransfer.types).includes(dragMime)
    );
  }
  function drop(event: DragEvent) {
    event.preventDefault();
    setDropTarget(false);
    const drag = localDrag;
    const accepted = accepts(event);
    localDrag = null;
    if (!accepted || !drag) return;
    let payload: unknown;
    try {
      payload = JSON.parse(event.dataTransfer.getData(dragMime));
    } catch {
      return;
    }
    if (
      payload &&
      typeof payload === 'object' &&
      'token' in payload &&
      'tool' in payload &&
      'side' in payload &&
      payload.token === drag.token &&
      payload.tool === drag.tool &&
      payload.side === drag.side
    )
      moveAndFocus(drag.tool, side, onMove);
  }

  return (
    <>
      <nav
        aria-label={`${side === 'left' ? 'Left' : 'Right'} tool windows`}
        data-sidebar-side={side}
        className={`sidebar-rail${dropTarget && !disabled ? ' sidebar-rail-drop-target' : ''}`}
        onDragOver={(event) => {
          if (accepts(event)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            setDropTarget(true);
          }
        }}
        onDragLeave={(event) => {
          if (
            !(event.relatedTarget instanceof Node) ||
            !event.currentTarget.contains(event.relatedTarget)
          )
            setDropTarget(false);
        }}
        onDrop={drop}
      >
        {tools.map((tool) => (
          <button
            key={tool}
            type="button"
            className="sidebar-rail-tool"
            data-sidebar-tool={tool}
            title={sidebarLabels[tool]}
            aria-label={sidebarLabels[tool]}
            aria-description="Drag to the other sidebar, or press Shift+F10 to move."
            aria-pressed={active === tool}
            aria-expanded={active === tool}
            aria-controls={`sidebar-panel-${tool}`}
            disabled={disabled}
            draggable={!disabled}
            onClick={() => onToggle(tool)}
            onContextMenu={(event) => {
              event.preventDefault();
              if (!disabled) {
                event.currentTarget.focus();
                setMoving(tool);
              }
            }}
            onKeyDown={(event) => {
              if (
                !disabled &&
                ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu')
              ) {
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.focus();
                setMoving(tool);
              }
            }}
            onDragStart={(event) => {
              if (disabled) {
                event.preventDefault();
                return;
              }
              localDrag = { tool, side, token: crypto.randomUUID() };
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData(dragMime, JSON.stringify(localDrag));
            }}
          >
            <Icon name={icons[tool]} />
            <span>{sidebarLabels[tool]}</span>
          </button>
        ))}
        {dropTarget && !disabled && (
          <span className="sidebar-drop-label" aria-hidden="true">
            Drop here
          </span>
        )}
        <button
          type="button"
          className="sidebar-rail-arrange"
          aria-label={`Arrange ${side} sidebar`}
          title={`Arrange ${side} sidebar`}
          disabled={disabled}
          onClick={() => setArranging(true)}
        >
          <span aria-hidden="true">⋯</span>
          <span>Arrange</span>
        </button>
      </nav>
      {moving && (
        <MoveDialog
          tool={moving}
          side={side}
          disabled={disabled}
          onMove={onMove}
          onClose={() => setMoving(null)}
        />
      )}
      {arranging && (
        <Modal title={`Arrange ${side} sidebar`} onClose={() => setArranging(false)}>
          <div className="modal-body sidebar-arrange-list">
            <p>Move a tool to the other sidebar. You can also drag its tab.</p>
            {!tools.length && (
              <p>This sidebar has no tools. Move a tool here from the other sidebar.</p>
            )}
            {tools.map((tool) => (
              <section key={tool} aria-label={sidebarLabels[tool]} className="sidebar-arrange-item">
                <h3>{sidebarLabels[tool]}</h3>
                <MoveActions
                  tool={tool}
                  side={side}
                  disabled={disabled}
                  onMove={(moved, destination) => {
                    setArranging(false);
                    moveAndFocus(moved, destination, onMove);
                  }}
                />
              </section>
            ))}
          </div>
          <div className="modal-actions">
            <button type="button" onClick={() => setArranging(false)}>
              Done
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
