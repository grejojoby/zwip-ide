// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskPanel } from './TaskPanel';
import {
  WorkspaceRunSession,
  type RunBackend,
  type RunConfiguration,
} from '../model/run-configurations';
afterEach(cleanup);
const configuration: RunConfiguration = {
  id: 'go',
  name: 'Service',
  command: 'go run .',
  workingDirectory: 'api',
  debug: {
    provider: 'go',
    mode: 'debug',
    path: 'api',
    workingDirectory: 'api',
    args: ['--port', '8080'],
  },
};
async function setup() {
  const backend: RunBackend = {
    getSetting: async <T,>() =>
      ({ version: 1, selectedId: 'go', configurations: [configuration] }) as T,
    setSetting: async <T,>(_key: string, value: T) => value,
    runTask: vi.fn(),
    taskStatus: vi.fn(),
    stopTask: vi.fn(),
  };
  vi.spyOn(backend, 'setSetting');
  const session = new WorkspaceRunSession('/fixture', backend);
  await session.load();
  render(<TaskPanel session={session} state={session.getSnapshot()} />);
  return backend;
}
it('preserves imported debugging when only the configuration name changes', async () => {
  const backend = await setup();
  fireEvent.change(screen.getByLabelText('Run configuration name'), {
    target: { value: 'Renamed' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
  await waitFor(() =>
    expect(backend.setSetting).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        configurations: [{ ...configuration, name: 'Renamed' }],
      }),
    ),
  );
  expect(backend.runTask).not.toHaveBeenCalled();
});
it.each(['Command to run', 'Run working directory'])(
  'clears debug metadata with a notice when %s changes',
  async (label) => {
    const backend = await setup();
    fireEvent.change(screen.getByLabelText(label), {
      target: { value: label === 'Command to run' ? 'go test .' : 'other' },
    });
    expect(
      screen.getByText(/Saving these changes removes the imported Go debug target/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
    await waitFor(() => expect(backend.setSetting).toHaveBeenCalledOnce());
    const settings = vi.mocked(backend.setSetting).mock.calls[0][1] as {
      configurations: RunConfiguration[];
    };
    expect(settings.configurations[0].debug).toBeUndefined();
    expect(backend.runTask).not.toHaveBeenCalled();
  },
);
