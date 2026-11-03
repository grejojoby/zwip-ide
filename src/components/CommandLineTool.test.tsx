// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { CommandLineTool } from './CommandLineTool';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
beforeEach(() => vi.stubGlobal('__TAURI_INTERNALS__', {}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
const status = { path: '/home/user/.local/bin/zwip', installed: false, unavailable: null };

describe('command-line installation', () => {
  it('shows usage and terminal setup, and installs only when requested', async () => {
    vi.mocked(invoke).mockResolvedValue(status);
    render(<CommandLineTool />);
    const install = await screen.findByRole('button', { name: 'Install zwip command' });
    expect(screen.getAllByText('zwip .').length).toBeGreaterThan(0);
    expect(screen.getByText('zwip path/to/file')).toBeTruthy();
    expect(screen.getByText(/export PATH=/)).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith('install_command_line_tool');
    vi.mocked(invoke).mockResolvedValue({ ...status, installed: true });
    fireEvent.click(install);
    expect(await screen.findByText(/Installed at/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Install zwip command' })).toBeNull();
  });

  it('reports installation errors and allows retry', async () => {
    vi.mocked(invoke).mockResolvedValue(status);
    render(<CommandLineTool />);
    const install = await screen.findByRole('button', { name: 'Install zwip command' });
    vi.mocked(invoke).mockRejectedValue(new Error('A different command already exists'));
    fireEvent.click(install);
    expect((await screen.findByRole('alert')).textContent).toContain('already exists');
    await waitFor(() => expect((install as HTMLButtonElement).disabled).toBe(false));
  });

  it('explains why a development executable cannot install a bundled launcher', async () => {
    vi.mocked(invoke).mockResolvedValue({
      ...status,
      unavailable: 'Open a built Zwip.app to install.',
    });
    render(<CommandLineTool />);
    expect(await screen.findByText('Open a built Zwip.app to install.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Install zwip command' })).toBeNull();
  });
});
