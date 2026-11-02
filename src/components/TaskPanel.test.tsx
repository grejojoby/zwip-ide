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
async function setup(onImport?: () => void) {
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
  render(<TaskPanel session={session} state={session.getSnapshot()} onImport={onImport} />);
  return backend;
}
it('preserves imported debugging when only the configuration name changes', async () => {
  const backend = await setup();
  fireEvent.click(screen.getByRole('button', { name: 'Edit configuration' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Edit configuration' }));
    if (label === 'Command to run')
      fireEvent.click(screen.getByRole('button', { name: 'Edit command' }));
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
it('offers IntelliJ import as the last dropdown choice without changing the selection', async () => {
  const onImport = vi.fn();
  await setup(onImport);
  const select = screen.getByLabelText<HTMLSelectElement>('Edit run configuration');
  const options = [...select.options];
  expect(options[options.length - 1].textContent).toBe('Import from IntelliJ…');
  fireEvent.change(select, { target: { value: options[options.length - 1].value } });
  expect(onImport).toHaveBeenCalledTimes(1);
  expect(select.value).toBe('go');
});
it('edits environment variables, keeps the debug target and rejects invalid lines', async () => {
  const backend = await setup();
  fireEvent.click(screen.getByRole('button', { name: 'Edit configuration' }));
  const env = screen.getByLabelText('Run environment variables');
  fireEvent.change(env, { target: { value: 'SETUP=c21-or\nbad line' } });
  expect(screen.getByRole('alert').textContent).toContain('NAME=value');
  expect(
    (screen.getByRole('button', { name: 'Save configuration' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.change(env, { target: { value: 'SETUP=c21-or\nPROFILE=dev' } });
  expect(screen.getByText('Unsaved changes')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
  await waitFor(() =>
    expect(backend.setSetting).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        configurations: [
          {
            ...configuration,
            env: [
              { name: 'SETUP', value: 'c21-or' },
              { name: 'PROFILE', value: 'dev' },
            ],
          },
        ],
      }),
    ),
  );
  expect(backend.runTask).not.toHaveBeenCalled();
});
it('keeps execution details out of output while showing progress and exit status', async () => {
  const backend: RunBackend = {
    getSetting: async <T,>() =>
      ({ version: 1, selectedId: 'go', configurations: [configuration] }) as T,
    setSetting: async <T,>(_key: string, value: T) => value,
    runTask: vi.fn(async () => ({ id: '1', output: '', exitCode: null, running: true })),
    taskStatus: vi.fn(async () => ({ id: '1', output: 'served\n', exitCode: 0, running: false })),
    stopTask: vi.fn(),
  };
  const session = new WorkspaceRunSession('/fixture', backend);
  await session.load();
  await session.runSelected();
  const view = render(<TaskPanel session={session} state={session.getSnapshot()} />);
  const output = () => screen.getByLabelText('Task output').textContent;
  expect(output()).not.toContain('go run .');
  expect(screen.queryByText('/fixture/api $ go run .')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Execution details' }));
  expect(screen.getByLabelText('Executed command').textContent).toBe('go run .');
  expect(output()).toMatch(/Running for \d+s · no output yet/);
  await waitFor(() => expect(backend.taskStatus).toHaveBeenCalled());
  view.rerender(<TaskPanel session={session} state={session.getSnapshot()} />);
  expect(output()).toContain('served\nProcess finished with exit code 0');
});

it('keeps saved commands and configuration fields hidden until requested', async () => {
  await setup();
  expect(screen.queryByLabelText('Command to run')).toBeNull();
  expect(screen.queryByLabelText('Run environment variables')).toBeNull();
  expect(screen.getByText('Runs in api')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Run' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Edit configuration' }));
  expect(screen.getByLabelText('Run configuration name')).toBeTruthy();
  expect(screen.queryByLabelText('Command to run')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Edit command' }));
  expect(screen.getByLabelText<HTMLInputElement>('Command to run').value).toBe(
    configuration.command,
  );
});

it('runs a saved configuration with one click while its command stays hidden', async () => {
  const backend = await setup();
  vi.mocked(backend.runTask).mockResolvedValue({
    id: 'task',
    output: 'done',
    exitCode: 0,
    running: false,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
  await waitFor(() =>
    expect(backend.runTask).toHaveBeenCalledWith(configuration.command, '/fixture/api'),
  );
  expect(screen.queryByLabelText('Command to run')).toBeNull();
});

it('keeps custom commands editable when creating a new configuration', async () => {
  const backend: RunBackend = {
    getSetting: async () => null,
    setSetting: async <T,>(_key: string, value: T) => value,
    runTask: vi.fn(async () => ({ id: 'task', output: 'done', exitCode: 0, running: false })),
    taskStatus: vi.fn(),
    stopTask: vi.fn(),
  };
  vi.spyOn(backend, 'setSetting');
  const session = new WorkspaceRunSession('/fixture', backend);
  await session.load();
  render(<TaskPanel session={session} state={session.getSnapshot()} />);
  fireEvent.change(screen.getByLabelText('Command to run'), { target: { value: 'printf done' } });
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
  await waitFor(() => expect(backend.runTask).toHaveBeenCalledWith('printf done', '/fixture'));
  expect(backend.setSetting).not.toHaveBeenCalled();
});
