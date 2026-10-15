// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { IntelliJImport } from './IntelliJImport';
import { DatabasePanel } from './tools/DatabasePanel';
import { defaultShortcuts } from '../model/shortcuts';
import type { IntelliJImportPreview } from '../model/intellij-import-contracts';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
const source = '/disposable/settings.xml';
const connection = {
  id: 'ready',
  name: 'Demo PostgreSQL',
  kind: 'postgres' as const,
  config: { host: '127.0.0.1', port: 1, database: 'demo', username: 'demo' },
};
function preview(): IntelliJImportPreview {
  return {
    source,
    fingerprint: 'reviewed-fingerprint',
    notices: [],
    keymaps: [
      {
        name: 'Demo',
        actions: [{ id: 'GotoFile', shortcuts: [{ first: 'meta shift P' }], hasMouse: false }],
      },
    ],
    runConfigurations: [],
    connections: [
      { id: 'ready', name: connection.name, status: 'ready', connection, notes: [] },
      {
        id: 'duplicate',
        name: 'Already saved database',
        status: 'duplicate',
        notes: ['Already exists.'],
      },
      {
        id: 'unsupported',
        name: 'Unsupported warehouse',
        status: 'unsupported',
        notes: ['Driver is not supported.'],
      },
    ],
    appearance: { name: 'Darcula', dark: true },
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
});
afterEach(cleanup);
function mount() {
  const onKeymap = vi.fn(),
    onAppearance = vi.fn(),
    onClose = vi.fn();
  render(
    <IntelliJImport
      shortcuts={defaultShortcuts}
      workspaceRoot="/disposable/project"
      onKeymap={onKeymap}
      onAppearance={onAppearance}
      onClose={onClose}
    />,
  );
  return { onKeymap, onAppearance, onClose };
}
async function inspect() {
  fireEvent.change(screen.getByLabelText('Settings source'), { target: { value: source } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview import' }));
  await screen.findByRole('region', { name: 'Database connection import' });
}
describe('IntelliJ import review', () => {
  it('offers an active stock keymap even when there is no custom keymap file', async () => {
    const onKeymap = vi.fn();
    render(
      <IntelliJImport
        shortcuts={{ ...defaultShortcuts, files: 'Ctrl-p' }}
        onKeymap={onKeymap}
        onAppearance={() => {}}
        onClose={() => {}}
      />,
    );
    vi.mocked(invoke).mockResolvedValueOnce({
      source,
      fingerprint: 'stock',
      keymaps: [],
      activeKeymap: 'Mac OS X 10.5+',
      connections: [],
      notices: [],
    });
    fireEvent.change(screen.getByLabelText('Settings source'), { target: { value: source } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview import' }));
    await screen.findByRole('region', { name: 'Keymap import' });
    expect((screen.getByLabelText('IntelliJ keymap') as HTMLSelectElement).value).toBe(
      'Mac OS X 10.5+',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use reviewed keybindings' }));
    expect(onKeymap).toHaveBeenCalledWith(
      expect.objectContaining({ files: defaultShortcuts.files }),
    );
  });
  it('refreshes an already mounted database list after import without selecting or connecting', async () => {
    const methods: string[] = [];
    let imported = false;
    vi.mocked(invoke).mockImplementation(async (_command, args) => {
      const method = (args as { method: string }).method;
      methods.push(method);
      if (method === 'connection.list') return imported ? [connection] : [];
      if (method === 'settings.get') return null;
      if (method === 'intellij.preview') return preview();
      if (method === 'intellij.importConnections') {
        imported = true;
        return { imported: 1, connections: [connection] };
      }
      throw new Error(`Unexpected operation: ${method}`);
    });
    render(<DatabasePanel onDirty={() => {}} />);
    mount();
    await inspect();
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 selected connection' }));
    const option = await screen.findByRole('option', { name: 'Demo PostgreSQL · postgres' });
    expect(option).toBeTruthy();
    expect((screen.getByLabelText('Saved database connection') as HTMLSelectElement).value).toBe(
      '',
    );
    expect(methods).toEqual([
      'connection.list',
      'settings.get',
      'intellij.preview',
      'intellij.importConnections',
      'connection.list',
      'settings.get',
    ]);
  });
  it('only previews first, disables unsupported entries, and saves selected connections without connecting', async () => {
    const callbacks = mount();
    expect(screen.queryByRole('button', { name: /Import .*selected connection/ })).toBeNull();
    vi.mocked(invoke).mockResolvedValueOnce(preview());
    await inspect();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenLastCalledWith('ide_request', {
      method: 'intellij.preview',
      params: { path: source, projectRoot: '/disposable/project' },
    });
    expect(callbacks.onKeymap).not.toHaveBeenCalled();
    expect(callbacks.onAppearance).not.toHaveBeenCalled();
    expect(
      (screen.getByRole('checkbox', { name: /Demo PostgreSQL/ }) as HTMLInputElement).checked,
    ).toBe(true);
    for (const name of [/Already saved database/, /Unsupported warehouse/]) {
      const checkbox = screen.getByRole('checkbox', { name }) as HTMLInputElement;
      expect(checkbox.disabled).toBe(true);
      expect(checkbox.checked).toBe(false);
    }
    const changed = vi.fn();
    window.addEventListener('zwip:connections-changed', changed);
    try {
      vi.mocked(invoke).mockResolvedValueOnce({ imported: 1, connections: [connection] });
      fireEvent.click(screen.getByRole('button', { name: 'Import 1 selected connection' }));
      await screen.findByText(/1 connection saved/);
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(invoke).toHaveBeenLastCalledWith('ide_request', {
        method: 'intellij.importConnections',
        params: {
          path: source,
          projectRoot: '/disposable/project',
          fingerprint: 'reviewed-fingerprint',
          ids: ['ready'],
        },
      });
      expect(changed).toHaveBeenCalledOnce();
      expect(
        (screen.getByRole('checkbox', { name: /Demo PostgreSQL/ }) as HTMLInputElement).disabled,
      ).toBe(true);
      expect(callbacks.onKeymap).not.toHaveBeenCalled();
      expect(callbacks.onAppearance).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('zwip:connections-changed', changed);
    }
  });
  it('invalidates reviewed selections when either source or original project changes', async () => {
    mount();
    vi.mocked(invoke).mockResolvedValueOnce(preview());
    await inspect();
    fireEvent.change(screen.getByLabelText('Settings source'), {
      target: { value: '/disposable/other.zip' },
    });
    expect(screen.queryByRole('region', { name: 'Database connection import' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use reviewed keybindings' })).toBeNull();
    vi.mocked(invoke).mockResolvedValueOnce(preview());
    fireEvent.click(screen.getByRole('button', { name: 'Preview import' }));
    await screen.findByRole('region', { name: 'Database connection import' });
    fireEvent.change(screen.getByLabelText('Original project directory (optional)'), {
      target: { value: '/disposable/another-project' },
    });
    expect(screen.queryByRole('region', { name: 'Database connection import' })).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it('keeps reviewed selections and settings intact when the import fails', async () => {
    const callbacks = mount();
    vi.mocked(invoke).mockResolvedValueOnce(preview());
    await inspect();
    vi.mocked(invoke).mockRejectedValueOnce(
      new Error('Source changed since preview. Preview it again.'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 selected connection' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Source changed');
    expect(
      (screen.getByRole('checkbox', { name: /Demo PostgreSQL/ }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(callbacks.onKeymap).not.toHaveBeenCalled();
    expect(callbacks.onAppearance).not.toHaveBeenCalled();
    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(
      (screen.getByRole('button', { name: 'Preview import' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
  it('keeps the modal and input ownership while a preview is pending, then reports a read error', async () => {
    const callbacks = mount();
    let reject!: (error: Error) => void;
    vi.mocked(invoke).mockReturnValueOnce(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    fireEvent.change(screen.getByLabelText('Settings source'), { target: { value: source } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview import' }));
    expect((screen.getByLabelText('Settings source') as HTMLInputElement).disabled).toBe(true);
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(callbacks.onClose).not.toHaveBeenCalled();
    await act(async () => reject(new Error('Malformed settings XML')));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Malformed settings XML'),
    );
    expect(screen.queryByRole('region', { name: 'Database connection import' })).toBeNull();
    expect(callbacks.onKeymap).not.toHaveBeenCalled();
    expect(callbacks.onAppearance).not.toHaveBeenCalled();
  });
});
