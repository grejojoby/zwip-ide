// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { Settings } from './Settings';
import { defaultShortcuts } from '../model/shortcuts';
import type { IntelliJImportPreview } from '../model/intellij-import-contracts';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
const history = { retentionDays: 7, maxBytes: 64 * 1024 * 1024 };
beforeEach(() => {
  vi.resetAllMocks();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
});
afterEach(cleanup);
function mount(onSave = vi.fn(async () => {})) {
  const onClose = vi.fn(),
    onTheme = vi.fn();
  const view = render(
    <Settings
      shortcuts={defaultShortcuts}
      history={history}
      dark
      workspaceRoot="/fixture"
      onSave={onSave}
      onTheme={onTheme}
      onClose={onClose}
    />,
  );
  return { ...view, onSave, onClose, onTheme };
}
async function importDraft(first = 'meta shift P') {
  const result: IntelliJImportPreview = {
    source: '/fixture/keymap.xml',
    fingerprint: 'source',
    runConfigurations: [],
    connections: [],
    notices: [],
    keymaps: [
      {
        name: 'Native fixture',
        actions: [{ id: 'GotoFile', shortcuts: [{ first }], hasMouse: false }],
      },
    ],
  };
  vi.mocked(invoke).mockResolvedValueOnce(result);
  fireEvent.click(screen.getByRole('button', { name: 'Import from IntelliJ…' }));
  const dialog = screen.getByRole('dialog', { name: 'Import from IntelliJ' });
  fireEvent.change(within(dialog).getByLabelText('Settings source'), {
    target: { value: '/fixture/keymap.xml' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Preview import' }));
  fireEvent.click(await within(dialog).findByRole('button', { name: 'Use reviewed keybindings' }));
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Import from IntelliJ' })).toBeNull(),
  );
}
describe('reviewed keybindings in Settings', () => {
  it('keeps imported shortcuts in the draft until Save, and cancellation retains the original settings', async () => {
    const first = mount();
    await importDraft();
    expect(screen.getByRole('button', { name: 'Shortcut for Go to file' }).textContent).toBe('⌘⇧P');
    expect(first.onSave).not.toHaveBeenCalled();
    expect(first.onTheme).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(first.onClose).toHaveBeenCalledOnce();
    first.unmount();
    const next = mount();
    expect(screen.getByRole('button', { name: 'Shortcut for Go to file' }).textContent).toBe('⌘⇧O');
    await importDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() =>
      expect(next.onSave).toHaveBeenCalledWith(
        { ...defaultShortcuts, files: 'Mod-Shift-p' },
        history,
      ),
    );
    expect(next.onClose).toHaveBeenCalledOnce();
  });
  it('blocks conflicting imported bindings until the conflict is resolved', async () => {
    const callbacks = mount();
    await importDraft('meta S');
    expect(screen.getByText(/Save file and Go to file both use/)).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(callbacks.onSave).not.toHaveBeenCalled();
    const binding = screen.getByRole('button', { name: 'Shortcut for Go to file' });
    fireEvent.click(binding);
    fireEvent.keyDown(binding, { key: 'p', code: 'KeyP', metaKey: true, shiftKey: true });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(callbacks.onSave).toHaveBeenCalledOnce());
  });
  it('keeps the imported draft visible after persistence fails without closing Settings', async () => {
    const callbacks = mount(
      vi.fn(async () => {
        throw new Error('Settings storage unavailable');
      }),
    );
    await importDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Settings storage unavailable',
    );
    expect(screen.getByRole('button', { name: 'Shortcut for Go to file' }).textContent).toBe('⌘⇧P');
    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(
      (screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
