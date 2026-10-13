// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { SidebarSide, SidebarTool } from '../model/sidebar-layout';
import { SidebarMoveButton, SidebarRail } from './SidebarRail';

function transfer() {
  const values = new Map<string, string>();
  return {
    effectAllowed: 'none',
    dropEffect: 'none',
    get types() {
      return [...values.keys()];
    },
    setData(type: string, value: string) {
      values.set(type, value);
    },
    getData(type: string) {
      return values.get(type) ?? '';
    },
  };
}
function Fixture({
  onMove = vi.fn(),
  disabled = false,
}: {
  onMove?: (tool: SidebarTool, side: SidebarSide) => void;
  disabled?: boolean;
}) {
  const [left, setLeft] = useState<SidebarTool[]>(['project', 'git', 'database', 'http']);
  const [right, setRight] = useState<SidebarTool[]>([]);
  const move = (tool: SidebarTool, side: SidebarSide) => {
    onMove(tool, side);
    setLeft((current) => [
      ...current.filter((item) => item !== tool),
      ...(side === 'left' ? [tool] : []),
    ]);
    setRight((current) => [
      ...current.filter((item) => item !== tool),
      ...(side === 'right' ? [tool] : []),
    ]);
  };
  return (
    <>
      <SidebarRail
        side="left"
        tools={left}
        active="git"
        onToggle={() => {}}
        onMove={move}
        disabled={disabled}
      />
      <SidebarRail
        side="right"
        tools={right}
        active={null}
        onToggle={() => {}}
        onMove={move}
        disabled={disabled}
      />
    </>
  );
}
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('sidebar rail', () => {
  it('exposes labeled toggles and the associated panel state', () => {
    const toggle = vi.fn();
    render(
      <SidebarRail
        side="left"
        tools={['project', 'git']}
        active="project"
        onToggle={toggle}
        onMove={() => {}}
      />,
    );
    const rail = screen.getByRole('navigation', { name: 'Left tool windows' });
    const project = within(rail).getByRole('button', { name: 'Project' });
    expect(project.getAttribute('aria-pressed')).toBe('true');
    expect(project.getAttribute('aria-expanded')).toBe('true');
    expect(project.getAttribute('aria-controls')).toBe('sidebar-panel-project');
    expect(project.getAttribute('draggable')).toBe('true');
    fireEvent.click(within(rail).getByRole('button', { name: 'Git' }));
    expect(toggle).toHaveBeenCalledWith('git');
  });

  it('moves via Shift+F10 and focuses the relocated tab', async () => {
    const moved = vi.fn();
    render(<Fixture onMove={moved} />);
    const git = screen.getByRole('button', { name: 'Git' });
    git.focus();
    fireEvent.keyDown(git, { key: 'F10', shiftKey: true });
    const dialog = screen.getByRole('dialog', { name: 'Move Git' });
    expect(
      (within(dialog).getByRole('button', { name: 'Move to left sidebar' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(document.activeElement).toBe(
      within(dialog).getByRole('button', { name: 'Move to right sidebar' }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move to right sidebar' }));
    expect(moved).toHaveBeenCalledWith('git', 'right');
    const right = screen.getByRole('navigation', { name: 'Right tool windows' });
    await waitFor(() =>
      expect(document.activeElement).toBe(within(right).getByRole('button', { name: 'Git' })),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens a right-click move dialog and cancels without moving', () => {
    const moved = vi.fn();
    render(<Fixture onMove={moved} />);
    const project = screen.getByRole('button', { name: 'Project' });
    fireEvent.contextMenu(project);
    const dialog = screen.getByRole('dialog', { name: 'Move Project' });
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(project);
    expect(moved).not.toHaveBeenCalled();
  });

  it('offers discoverable arrangement controls and an empty-rail explanation', () => {
    const moved = vi.fn();
    render(<Fixture onMove={moved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Arrange left sidebar' }));
    const database = screen.getByRole('region', { name: 'Database' });
    fireEvent.click(within(database).getByRole('button', { name: 'Move to right sidebar' }));
    expect(moved).toHaveBeenCalledWith('database', 'right');
    cleanup();
    render(
      <SidebarRail side="right" tools={[]} active={null} onToggle={() => {}} onMove={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Arrange right sidebar' }));
    expect(
      screen.getByText('This sidebar has no tools. Move a tool here from the other sidebar.'),
    ).toBeTruthy();
  });

  it('accepts a local drag anywhere on the empty opposite rail', async () => {
    const moved = vi.fn();
    render(<Fixture onMove={moved} />);
    const dataTransfer = transfer();
    fireEvent.dragStart(screen.getByRole('button', { name: 'HTTP' }), { dataTransfer });
    expect(dataTransfer.effectAllowed).toBe('move');
    expect(dataTransfer.types).toEqual(['application/x-zwip-sidebar-tool']);
    const right = screen.getByRole('navigation', { name: 'Right tool windows' });
    const over = createEvent.dragOver(right, { dataTransfer });
    fireEvent(right, over);
    expect(over.defaultPrevented).toBe(true);
    expect(dataTransfer.dropEffect).toBe('move');
    expect(right.className).toContain('sidebar-rail-drop-target');
    fireEvent.drop(right, { dataTransfer });
    expect(moved).toHaveBeenCalledWith('http', 'right');
    expect(right.className).not.toContain('sidebar-rail-drop-target');
    await waitFor(() =>
      expect(document.activeElement).toBe(within(right).getByRole('button', { name: 'HTTP' })),
    );
  });

  it('rejects external, malformed and same-side drops', () => {
    const moved = vi.fn();
    render(<Fixture onMove={moved} />);
    const dataTransfer = transfer();
    dataTransfer.setData(
      'application/x-zwip-sidebar-tool',
      JSON.stringify({ tool: 'git', side: 'left', token: 'external' }),
    );
    const right = screen.getByRole('navigation', { name: 'Right tool windows' });
    fireEvent.drop(right, { dataTransfer });
    expect(moved).not.toHaveBeenCalled();
    fireEvent.dragStart(screen.getByRole('button', { name: 'Git' }), { dataTransfer });
    const key = dataTransfer.types[0];
    const forged = JSON.parse(dataTransfer.getData(key));
    dataTransfer.setData(key, JSON.stringify({ ...forged, tool: 'database' }));
    fireEvent.drop(right, { dataTransfer });
    expect(moved).not.toHaveBeenCalled();
    fireEvent.dragStart(screen.getByRole('button', { name: 'Git' }), { dataTransfer });
    dataTransfer.setData('application/x-zwip-sidebar-tool', '{bad JSON');
    fireEvent.drop(right, { dataTransfer });
    expect(moved).not.toHaveBeenCalled();
    fireEvent.dragStart(screen.getByRole('button', { name: 'Git' }), { dataTransfer });
    fireEvent.drop(screen.getByRole('navigation', { name: 'Left tool windows' }), { dataTransfer });
    expect(moved).not.toHaveBeenCalled();
  });

  it('clears drag feedback on drag end or Escape and rejects stale drag payloads', () => {
    const moved = vi.fn();
    render(<Fixture onMove={moved} />);
    const dataTransfer = transfer();
    const git = screen.getByRole('button', { name: 'Git' });
    const right = screen.getByRole('navigation', { name: 'Right tool windows' });
    fireEvent.dragStart(git, { dataTransfer });
    fireEvent.dragOver(right, { dataTransfer });
    fireEvent.dragEnd(git, { dataTransfer });
    expect(right.className).not.toContain('sidebar-rail-drop-target');
    fireEvent.drop(right, { dataTransfer });
    expect(moved).not.toHaveBeenCalled();
    fireEvent.dragStart(git, { dataTransfer });
    fireEvent.dragOver(right, { dataTransfer });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(right.className).not.toContain('sidebar-rail-drop-target');
    fireEvent.drop(right, { dataTransfer });
    expect(moved).not.toHaveBeenCalled();
  });

  it('disables toggles, arranging and drag transfers during unavailable state', () => {
    const moved = vi.fn();
    render(<Fixture onMove={moved} disabled />);
    const git = screen.getByRole('button', { name: 'Git' }) as HTMLButtonElement;
    expect(git.disabled).toBe(true);
    expect(git.draggable).toBe(false);
    const dataTransfer = transfer();
    fireEvent.dragStart(git, { dataTransfer });
    fireEvent.contextMenu(git);
    fireEvent.drop(screen.getByRole('navigation', { name: 'Right tool windows' }), {
      dataTransfer,
    });
    expect(dataTransfer.types).toEqual([]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(moved).not.toHaveBeenCalled();
  });

  it('reuses the move dialog from a panel-header button', () => {
    const moved = vi.fn();
    render(<SidebarMoveButton tool="database" side="right" onMove={moved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Move Database' }));
    const dialog = screen.getByRole('dialog', { name: 'Move Database' });
    expect(
      (within(dialog).getByRole('button', { name: 'Move to right sidebar' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move to left sidebar' }));
    expect(moved).toHaveBeenCalledWith('database', 'left');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not steal focus when moving opens a pending-changes dialog', async () => {
    const guard = document.createElement('dialog');
    const cancel = document.createElement('button');
    cancel.textContent = 'Keep editing';
    guard.append(cancel);
    const moved = () => {
      document.body.append(guard);
      guard.showModal();
      cancel.focus();
    };
    render(<Fixture onMove={moved} />);
    const dataTransfer = transfer();
    fireEvent.dragStart(screen.getByRole('button', { name: 'Git' }), { dataTransfer });
    fireEvent.drop(screen.getByRole('navigation', { name: 'Right tool windows' }), {
      dataTransfer,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.activeElement).toBe(cancel);
    guard.remove();
  });
});
