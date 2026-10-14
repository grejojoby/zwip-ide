// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { EditorContextMenu, type MenuEntry } from './EditorContextMenu';
afterEach(cleanup);

it('runs actions, shows shortcuts and ticks, and opens submenus from the keyboard', () => {
  const rename = vi.fn();
  const copy = vi.fn();
  const onClose = vi.fn();
  const entries: MenuEntry[] = [
    { label: 'Copy Reference', shortcut: '⌥⇧⌘C', run: copy },
    'separator',
    { label: 'Refactor', children: [{ label: 'Rename…', shortcut: '⇧F6', run: rename }] },
    { label: 'Git', children: [{ label: 'Annotate with Git Blame', checked: true }] },
    { label: 'Debug', disabled: true },
  ];
  render(<EditorContextMenu x={10} y={10} entries={entries} onClose={onClose} />);
  expect(screen.getByRole('menuitem', { name: /Copy Reference/ }).textContent).toContain('⌥⇧⌘C');
  expect((screen.getByRole('menuitem', { name: 'Debug' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  const refactor = screen.getByRole('menuitem', { name: /Refactor/ });
  fireEvent.keyDown(refactor, { key: 'ArrowRight' });
  fireEvent.click(screen.getByRole('menuitem', { name: /Rename/ }));
  expect(rename).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalled();
  fireEvent.click(screen.getByRole('menuitem', { name: /Git/ }));
  expect(
    screen
      .getByRole('menuitemcheckbox', { name: /Annotate with Git Blame/ })
      .getAttribute('aria-checked'),
  ).toBe('true');
  fireEvent.click(screen.getByRole('menuitem', { name: /Copy Reference/ }));
  expect(copy).toHaveBeenCalledOnce();
});
