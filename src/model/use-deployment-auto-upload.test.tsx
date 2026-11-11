// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../api';
import { useDeploymentAutoUpload } from './use-deployment-auto-upload';
vi.mock('../api', () => ({
  api: { getSetting: vi.fn(), packages: vi.fn(), toolRequest: vi.fn() },
}));
beforeEach(() => {
  vi.mocked(api.getSetting).mockResolvedValue({ serverId: 'server', credentialId: 'credential' });
  vi.mocked(api.packages).mockResolvedValue([{ id: 'deployment', enabled: true } as never]);
  vi.mocked(api.toolRequest).mockResolvedValue({ skipped: 'test' });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});
const saved = (revision = 1, path = '/workspace/file') =>
  window.dispatchEvent(
    new CustomEvent('zwip:document-saved', {
      detail: { path, revision, workspaceGeneration: 1, hash: 'a'.repeat(64) },
    }),
  );
it('coalesces acknowledged saves, keeps their identities and ignores other workspaces', async () => {
  renderHook(() => useDeploymentAutoUpload('/workspace', 1, () => {}));
  await waitFor(() => expect(api.packages).toHaveBeenCalled());
  vi.useFakeTimers();
  await act(async () => {
    saved(1);
    saved(2);
    saved(1, '/other/file');
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(api.toolRequest).toHaveBeenCalledTimes(1);
  expect(api.toolRequest).toHaveBeenCalledWith(
    'deployment',
    'upload.auto',
    {
      workspaceRoot: '/workspace',
      serverId: 'server',
      saved: [
        { path: '/workspace/file', revision: 2, workspaceGeneration: 1, hash: 'a'.repeat(64) },
      ],
    },
    false,
    'credential',
  );
});
it('does not start the package or upload when automatic upload is off', async () => {
  vi.mocked(api.getSetting).mockResolvedValue(null);
  renderHook(() => useDeploymentAutoUpload('/workspace', 1, () => {}));
  await act(async () => {
    await Promise.resolve();
    saved();
  });
  expect(api.packages).not.toHaveBeenCalled();
  expect(api.toolRequest).not.toHaveBeenCalled();
});
