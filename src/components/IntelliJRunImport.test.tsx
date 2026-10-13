// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { WorkspaceRunSession, type RunBackend } from '../model/run-configurations';
import type { IntelliJImportPreview } from '../model/intellij-import-contracts';
import { IntelliJRunImport } from './IntelliJRunImport';

vi.mock('../api', () => ({ api: { previewIntelliJ: vi.fn() } }));
const root = '/fixture/project';
const preview: IntelliJImportPreview = {
  source: 'Selected settings folder',
  fingerprint: 'reviewed',
  keymaps: [],
  connections: [],
  notices: [],
  runConfigurations: [
    {
      id: 'npm-dev',
      name: 'Web dev',
      type: 'js.build_tools.npm',
      status: 'ready',
      notes: [],
      fields: {
        packageJson: '$PROJECT_DIR$/web/package.json',
        command: 'run-script',
        scripts: ['dev'],
      },
    },
    {
      id: 'java',
      name: 'Java service',
      type: 'Application',
      status: 'unsupported',
      fields: {},
      notes: ['Java runtime is not supported.'],
    },
  ],
};
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);
async function mount() {
  const backend: RunBackend = {
    getSetting: vi.fn().mockResolvedValue(null),
    setSetting: vi.fn().mockImplementation(async (_key, value) => value),
    runTask: vi.fn(),
    taskStatus: vi.fn(),
    stopTask: vi.fn(),
  };
  const session = new WorkspaceRunSession(root, backend);
  await session.load();
  const onError = vi.fn(),
    onMessage = vi.fn();
  render(
    <IntelliJRunImport
      preview={preview}
      path="/fixture/.idea"
      projectRoot={root}
      session={session}
      busy={false}
      onBusy={() => {}}
      onMessage={onMessage}
      onError={onError}
    />,
  );
  return { backend, session, onError, onMessage };
}
describe('reviewed run configuration import', () => {
  it('requires selection, saves the reviewed batch and never launches it', async () => {
    vi.mocked(api.previewIntelliJ).mockResolvedValue(preview);
    const { backend, session, onMessage } = await mount();
    const checkbox = screen.getByRole('checkbox', { name: /Web dev/ }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(
      (screen.getByRole('checkbox', { name: /Java service/ }) as HTMLInputElement).disabled,
    ).toBe(true);
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 selected run configuration' }));
    await waitFor(() =>
      expect(onMessage).toHaveBeenCalledWith(expect.stringContaining('1 run configuration saved')),
    );
    expect(backend.setSetting).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().settings.selectedId).toBeNull();
    expect(session.getSnapshot().settings.configurations[0].workingDirectory).toBe('web');
    expect(backend.runTask).not.toHaveBeenCalled();
    expect((screen.getByRole('checkbox', { name: /Web dev/ }) as HTMLInputElement).disabled).toBe(
      true,
    );
  });
  it('rejects a changed source before touching saved configurations', async () => {
    vi.mocked(api.previewIntelliJ).mockResolvedValue({ ...preview, fingerprint: 'changed' });
    const { backend, onError } = await mount();
    fireEvent.click(screen.getByRole('checkbox', { name: /Web dev/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 selected run configuration' }));
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(expect.stringContaining('source changed')),
    );
    expect(backend.setSetting).not.toHaveBeenCalled();
    expect(backend.runTask).not.toHaveBeenCalled();
    expect((screen.getByRole('checkbox', { name: /Web dev/ }) as HTMLInputElement).checked).toBe(
      true,
    );
  });
  it('keeps selection and the previous configuration state when saving fails', async () => {
    vi.mocked(api.previewIntelliJ).mockResolvedValue(preview);
    const { backend, session, onError } = await mount();
    vi.mocked(backend.setSetting).mockRejectedValueOnce(new Error('disk is full'));
    fireEvent.click(screen.getByRole('checkbox', { name: /Web dev/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 selected run configuration' }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('disk is full'));
    expect(session.getSnapshot().settings.configurations).toHaveLength(0);
    expect((screen.getByRole('checkbox', { name: /Web dev/ }) as HTMLInputElement).checked).toBe(
      true,
    );
  });
});
