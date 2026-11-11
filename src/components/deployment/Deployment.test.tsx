// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api } from '../../api';
import { Deployment } from './Deployment';
import { ServerEditor } from './ServerEditor';
import {
  newDeploymentServer,
  type DeploymentPlan,
  type DeploymentSettings,
} from '../../model/deployment-contracts';
vi.mock('../../api', () => ({
  api: {
    packages: vi.fn(),
    toolRequest: vi.fn(),
    setSetting: vi.fn(),
    setPackageCredential: vi.fn(),
    deletePackageCredential: vi.fn(),
  },
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
const root = '/workspace';
const server = {
  ...newDeploymentServer('server'),
  name: 'Staging',
  host: 'sftp.example.test',
  username: 'user',
  fingerprint: 'SHA256:' + 'a'.repeat(43),
  root: '/srv/site',
};
let settings: DeploymentSettings;
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  settings = { revision: 1, servers: [server], defaultId: server.id, autoUpload: 'never' };
  vi.mocked(api.packages).mockResolvedValue([{ id: 'deployment', enabled: true } as never]);
  vi.mocked(api.toolRequest).mockImplementation(async (_id, method, params) => {
    if (method === 'settings.get') return structuredClone(settings) as never;
    if (method === 'settings.save') {
      settings = { ...(params!.settings as DeploymentSettings), revision: 2 };
      return settings as never;
    }
    if (method === 'transfer.status') return null as never;
    if (method === 'host.probe')
      return { fingerprint: server.fingerprint, algorithm: 'ssh-ed25519' } as never;
    if (method === 'connection.test') return { root: '/srv/site' } as never;
    return {} as never;
  });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it('offers the optional package without starting its worker when not enabled', async () => {
  vi.mocked(api.packages).mockResolvedValue([]);
  const packages = vi.fn();
  render(<Deployment root={root} onClose={() => {}} onPackages={packages} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Manage packages' }));
  expect(packages).toHaveBeenCalled();
  expect(api.toolRequest).not.toHaveBeenCalled();
});
it('requires explicit trust, tests the pinned key and invalidates trust after an endpoint edit', async () => {
  const save = vi.fn(async () => {});
  render(
    <ServerEditor
      root={root}
      initial={{ ...server, fingerprint: '' }}
      onSave={save}
      onClose={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review server key' }));
  await screen.findByRole('button', { name: 'Trust this server key' });
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Trust this server key' }));
  fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
  await screen.findByText(/Connected successfully/);
  expect(api.toolRequest).toHaveBeenCalledWith(
    'deployment',
    'connection.test',
    expect.objectContaining({
      server: expect.objectContaining({ fingerprint: server.fingerprint }),
    }),
    false,
    undefined,
  );
  fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'other.example.test' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save server' }));
  expect((await screen.findByRole('alert')).textContent).toContain('trust');
  expect(save).not.toHaveBeenCalled();
});
it('previews saved files and uploads only the reviewed eligible selection', async () => {
  const preview: DeploymentPlan = {
    id: 'preview',
    serverId: 'server',
    serverName: 'Staging',
    root: '/srv/site',
    revision: 1,
    createdAt: Date.now(),
    excluded: 1,
    files: [
      {
        key: 'new',
        local: 'public/new.html',
        remote: 'new.html',
        action: 'create',
        bytes: 10,
        hash: 'a'.repeat(64),
        remoteHash: null,
        mtime: 0,
      },
      {
        key: 'conflict',
        local: 'public/remote.html',
        remote: 'remote.html',
        action: 'conflict',
        bytes: 10,
        hash: 'a'.repeat(64),
        remoteHash: 'b'.repeat(64),
        mtime: 0,
      },
    ],
  };
  const original = vi.mocked(api.toolRequest).getMockImplementation()!;
  vi.mocked(api.toolRequest).mockImplementation(async (...args) => {
    if (args[1] === 'upload.plan') return preview as never;
    if (args[1] === 'upload.start')
      return {
        id: 'job',
        serverId: 'server',
        serverName: 'Staging',
        status: 'running',
        startedAt: 0,
        files: [],
      } as never;
    return original(...args);
  });
  render(
    <Deployment
      root={root}
      currentPath="/workspace/public/new.html"
      onClose={() => {}}
      onPackages={() => {}}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Preview upload' }));
  const upload = await screen.findByRole('button', { name: 'Upload 1 file' });
  expect((screen.getByLabelText('Upload public/remote.html') as HTMLInputElement).checked).toBe(
    false,
  );
  fireEvent.click(upload);
  await screen.findByRole('button', { name: 'Cancel upload' });
  expect(api.toolRequest).toHaveBeenCalledWith(
    'deployment',
    'upload.start',
    { workspaceRoot: root, planId: 'preview', keys: ['new'] },
    false,
    undefined,
  );
});
it('enables automatic upload only through an explicit settings change for the default server', async () => {
  render(<Deployment root={root} onClose={() => {}} onPackages={() => {}} />);
  fireEvent.change(await screen.findByLabelText('Automatic upload'), {
    target: { value: 'onSave' },
  });
  await waitFor(() =>
    expect(api.setSetting).toHaveBeenCalledWith('zwip./workspace.deployment.autoUpload', {
      serverId: 'server',
      credentialId: undefined,
    }),
  );
  expect(settings.autoUpload).toBe('onSave');
  expect(api.toolRequest).not.toHaveBeenCalledWith(
    'deployment',
    'upload.start',
    expect.anything(),
    expect.anything(),
    expect.anything(),
  );
});
it('allows editing a configured session-authenticated server without re-entering its password', async () => {
  const save = vi.fn(async () => {});
  render(
    <ServerEditor
      root={root}
      initial={{ ...server, auth: 'password' }}
      onSave={save}
      onClose={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save server' }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'server', auth: 'password' }),
      '',
      false,
    ),
  );
});
