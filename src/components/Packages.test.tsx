// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PackageState } from '../contracts';
import { Packages } from './Packages';

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('../api', () => ({
  api: {
    packages: vi.fn(),
    packageCatalog: vi.fn(),
    installCatalogPackage: vi.fn(),
    packageInstallProgress: vi.fn(),
    enablePackage: vi.fn(),
  },
}));
const { api } = await import('../api');
const state = (overrides: Partial<PackageState>): PackageState => ({
  id: 'go',
  name: 'Go Languages',
  description: 'Go',
  version: '0.1.0',
  installed: false,
  enabled: false,
  running: false,
  capabilities: [],
  ...overrides,
});
const entry = (id: string, version: string) => ({
  id,
  name: id,
  version,
  url: `https://example.test/${id}.zip`,
  sha256: 'a'.repeat(64),
  platform: 'darwin',
  architecture: 'arm64',
  dependencies: {},
});
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  vi.mocked(api.packageCatalog).mockResolvedValue({
    url: 'https://example.test/catalog.json',
    packages: [entry('go', '0.2.0'), entry('web', '0.1.0')],
  });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('Packages', () => {
  it('offers Download beside Enable and Update for an older installed version', async () => {
    vi.mocked(api.packages).mockResolvedValue([
      state({ id: 'go', installed: true }),
      state({ id: 'web', name: 'Web' }),
    ]);
    render(<Packages onClose={() => {}} />);
    expect(await screen.findByRole('button', { name: 'Update to 0.2.0' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Enable' })).toHaveLength(2);
  });
  it('shows download progress while a package installs', async () => {
    vi.mocked(api.packages).mockResolvedValue([
      state({ id: 'go', installed: true, version: '0.2.0' }),
      state({ id: 'web', name: 'Web' }),
    ]);
    let finish: (value: PackageState[]) => void = () => {};
    vi.mocked(api.installCatalogPackage).mockReturnValue(
      new Promise((accept) => {
        finish = accept;
      }),
    );
    vi.mocked(api.packageInstallProgress).mockResolvedValue({
      web: { phase: 'downloading', received: 1024 * 1024, total: 4 * 1024 * 1024 },
    });
    render(<Packages onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    expect(api.installCatalogPackage).toHaveBeenCalledWith('web', '0.1.0');
    expect(await screen.findByText('Downloading 1.0 MB of 4.0 MB')).toBeTruthy();
    finish([
      state({ id: 'go', installed: true, version: '0.2.0' }),
      state({ id: 'web', name: 'Web', installed: true }),
    ]);
    await waitFor(() => expect(screen.queryByText(/Downloading/)).toBeNull());
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
  });
});
