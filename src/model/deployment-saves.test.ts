// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { webcrypto, createHash } from 'node:crypto';
import { enableDeploymentSaveNotifications, notifyDeploymentSave } from './deployment-saves';
afterEach(() => {
  enableDeploymentSaveNotifications(false);
  vi.unstubAllGlobals();
});
it('announces the acknowledged saved bytes with their revision and generation', async () => {
  vi.stubGlobal('crypto', webcrypto);
  enableDeploymentSaveNotifications(true);
  const listener = vi.fn();
  window.addEventListener('zwip:document-saved', listener, { once: true });
  await notifyDeploymentSave({
    path: '/workspace/file',
    content: 'saved bytes',
    revision: 3,
    workspaceGeneration: 7,
    dirty: false,
  });
  expect(listener.mock.calls[0][0].detail).toEqual({
    path: '/workspace/file',
    hash: createHash('sha256').update('saved bytes').digest('hex'),
    revision: 3,
    workspaceGeneration: 7,
  });
});
it('does not hash editor content when automatic deployment is disabled', async () => {
  const digest = vi.fn();
  vi.stubGlobal('crypto', { subtle: { digest } });
  await notifyDeploymentSave({
    path: '/workspace/file',
    content: 'saved bytes',
    revision: 1,
    workspaceGeneration: 1,
    dirty: false,
  });
  expect(digest).not.toHaveBeenCalled();
});
