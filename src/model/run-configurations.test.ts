import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskResult } from '../contracts';
import {
  readRunSettings,
  relativeWorkingDirectory,
  runDirectory,
  runSettingsKey,
  WorkspaceRunSession,
  type RunBackend,
  type RunConfiguration,
} from './run-configurations';

const configuration: RunConfiguration = {
  id: 'web-dev',
  name: 'Frontend',
  command: 'npm run dev',
  workingDirectory: 'apps/web',
};
const completed: TaskResult = { id: 'task-1', running: false, exitCode: 0, output: 'done\n' };
function backend() {
  const storage = new Map<string, unknown>();
  const api: RunBackend = {
    getSetting: <T>(key: string) => Promise.resolve((storage.get(key) ?? null) as T | null),
    setSetting: <T>(key: string, value: T) => {
      storage.set(key, structuredClone(value));
      return Promise.resolve(value);
    },
    runTask: vi.fn(() => Promise.resolve(completed)),
    taskStatus: vi.fn(() => Promise.resolve(completed)),
    stopTask: vi.fn(() => Promise.resolve()),
  };
  vi.spyOn(api, 'setSetting');
  return { api, storage };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('workspace run configurations', () => {
  it('imports a validated batch atomically, preserves selection and never executes it', async () => {
    const { api } = backend();
    const session = new WorkspaceRunSession('/project', api);
    await session.load();
    await session.save(configuration);
    const imported: RunConfiguration = {
      id: 'go-service',
      name: 'Service',
      command: 'go run .',
      workingDirectory: 'services/api',
      debug: {
        provider: 'go',
        mode: 'debug',
        path: './services/api',
        workingDirectory: 'services/api',
        args: ['--port', '8080'],
      },
    };
    expect(await session.importConfigurations([imported])).toBe(true);
    expect(session.getSnapshot().settings.selectedId).toBe(configuration.id);
    expect(session.getSnapshot().settings.configurations[1]).toEqual({
      ...imported,
      debug: { ...imported.debug, path: 'services/api' },
    });
    expect(api.setSetting).toHaveBeenCalledTimes(2);
    const reopened = new WorkspaceRunSession('/project', api);
    await reopened.load();
    expect(reopened.getSnapshot().settings).toEqual(session.getSnapshot().settings);
    expect(api.runTask).not.toHaveBeenCalled();
  });

  it('rejects duplicate and invalid imported entries without partially saving any of the batch', async () => {
    const { api } = backend();
    const session = new WorkspaceRunSession('/project', api);
    await session.load();
    await session.save(configuration);
    const valid = { ...configuration, id: 'new', name: 'New' };
    for (const invalid of [
      { ...valid, id: configuration.id },
      { ...valid, name: configuration.name },
      { ...valid, workingDirectory: '../outside' },
      { ...valid, debug: { provider: 'go', mode: 'debug', path: '../outside', args: [] } },
      { ...valid, debug: { provider: 'go', mode: 'debug', path: '.', args: [42] } },
    ]) {
      expect(await session.importConfigurations([valid, invalid as RunConfiguration])).toBe(false);
      expect(session.getSnapshot().settings.configurations).toEqual([configuration]);
    }
    expect(api.setSetting).toHaveBeenCalledTimes(1);
    expect(api.runTask).not.toHaveBeenCalled();
  });

  it('keeps prior configurations and selection when an import write fails', async () => {
    const { api } = backend();
    const session = new WorkspaceRunSession('/project', api);
    await session.load();
    await session.save(configuration);
    vi.mocked(api.setSetting).mockRejectedValueOnce(new Error('disk full'));
    expect(await session.importConfigurations([{ ...configuration, id: 'new', name: 'New' }])).toBe(
      false,
    );
    expect(session.getSnapshot().settings).toEqual({
      version: 1,
      selectedId: configuration.id,
      configurations: [configuration],
    });
    expect(session.getSnapshot().error).toBe('disk full');
    expect(api.runTask).not.toHaveBeenCalled();
  });

  it('persists named configurations and selection separately for each workspace without autorunning', async () => {
    const { api, storage } = backend();
    const first = new WorkspaceRunSession('/first', api);
    const second = new WorkspaceRunSession('/second', api);
    await Promise.all([first.load(), second.load()]);
    expect(await first.save(configuration)).toBe(true);
    expect(await second.save({ ...configuration, command: 'make serve' })).toBe(true);
    expect(storage.has(runSettingsKey('/first'))).toBe(true);
    expect(storage.has(runSettingsKey('/second'))).toBe(true);
    const reopened = new WorkspaceRunSession('/first', api);
    await reopened.load();
    expect(reopened.getSnapshot().settings).toEqual({
      version: 1,
      selectedId: 'web-dev',
      configurations: [configuration],
    });
    expect(api.runTask).not.toHaveBeenCalled();
    expect(await reopened.runSelected()).toBe(true);
    expect(api.runTask).toHaveBeenCalledWith('npm run dev', '/first/apps/web');
  });

  it('keeps the previous saved data when persistence fails and prevents overlapping writes', async () => {
    const { api } = backend();
    const session = new WorkspaceRunSession('/project', api);
    await session.load();
    await session.save(configuration);
    let rejectWrite!: (error: Error) => void;
    vi.mocked(api.setSetting).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectWrite = reject;
        }),
    );
    const save = session.save({ ...configuration, command: 'changed' });
    expect(session.getSnapshot().saving).toBe(true);
    expect(session.getSnapshot().settings.configurations[0].command).toBe('npm run dev');
    expect(await session.remove(configuration.id)).toBe(false);
    expect(await session.runSelected()).toBe(false);
    rejectWrite(new Error('disk full'));
    expect(await save).toBe(false);
    expect(session.getSnapshot().settings.configurations[0]).toEqual(configuration);
    expect(session.getSnapshot().error).toBe('disk full');
  });

  it('removes a selected configuration durably and preserves other configurations', async () => {
    const { api } = backend();
    const session = new WorkspaceRunSession('/project', api);
    await session.load();
    await session.save(configuration);
    await session.save({ ...configuration, id: 'test', name: 'Tests', command: 'npm test' });
    await session.remove('test');
    const reopened = new WorkspaceRunSession('/project', api);
    await reopened.load();
    expect(reopened.getSnapshot().settings.selectedId).toBe(null);
    expect(reopened.getSnapshot().settings.configurations).toEqual([configuration]);
    expect(await reopened.runSelected()).toBe(false);
  });

  it('supports ad hoc execution, output polling and stop without creating a configuration', async () => {
    const { api } = backend();
    vi.mocked(api.runTask).mockResolvedValue({
      ...completed,
      running: true,
      exitCode: null,
      output: 'started\n',
    });
    vi.mocked(api.taskStatus).mockResolvedValueOnce({
      ...completed,
      running: true,
      exitCode: null,
      output: 'more output\n',
    });
    const session = new WorkspaceRunSession('/project', api);
    await session.load();
    expect(await session.run('printf done', './tools')).toBe(true);
    expect(await session.run('duplicate', '.')).toBe(false);
    await vi.advanceTimersByTimeAsync(400);
    expect(session.getSnapshot().task?.output).toBe('more output\n');
    await session.stop();
    expect(api.stopTask).toHaveBeenCalledWith('task-1');
    expect(session.getSnapshot().task?.running).toBe(false);
    expect(session.getSnapshot().settings.configurations).toEqual([]);
    expect(api.setSetting).not.toHaveBeenCalled();
  });

  it('rejects duplicate names, invalid directories and malformed saved settings without writes or runs', async () => {
    const { api } = backend();
    const session = new WorkspaceRunSession('/project', api);
    await session.load();
    await session.save(configuration);
    expect(await session.save({ ...configuration, id: 'duplicate' })).toBe(false);
    expect(await session.save({ ...configuration, workingDirectory: '../outside' })).toBe(false);
    expect(await session.run('pwd', '/outside')).toBe(false);
    expect(api.setSetting).toHaveBeenCalledTimes(1);
    expect(api.runTask).not.toHaveBeenCalled();
    expect(() => readRunSettings({ version: 2, configurations: [] })).toThrow(/invalid/);
    expect(() =>
      readRunSettings({
        version: 1,
        selectedId: null,
        configurations: [configuration, configuration],
      }),
    ).toThrow(/duplicate IDs/);
  });

  it('normalizes workspace-relative paths and rejects escape or ambiguous home paths', () => {
    expect(relativeWorkingDirectory(' ./apps//web/ ')).toBe('apps/web');
    expect(runDirectory('/project/', '.')).toBe('/project/');
    expect(runDirectory('/', 'apps')).toBe('/apps');
    for (const path of [
      '../other',
      'apps/../other',
      '/tmp',
      '~',
      '~/src',
      'C:\\src',
      'foo\nbar',
      'foo\0bar',
    ])
      expect(() => relativeWorkingDirectory(path)).toThrow(/relative/);
  });

  it('permits another run after a workspace switch removes the previous Core task', async () => {
    const { api } = backend();
    vi.mocked(api.runTask).mockResolvedValueOnce({ ...completed, running: true, exitCode: null });
    vi.mocked(api.taskStatus).mockRejectedValueOnce(new Error('Task not found'));
    const session = new WorkspaceRunSession('/project', api);
    await session.load();
    await session.run('first', '.');
    await vi.advanceTimersByTimeAsync(400);
    expect(session.getSnapshot().task).toMatchObject({ running: false, output: 'done\n' });
    expect(session.getSnapshot().error).toBe('Task not found');
    expect(await session.run('second', '.')).toBe(true);
    expect(api.runTask).toHaveBeenCalledTimes(2);
  });

  it('ignores an older status response after stop reports the task complete', async () => {
    const { api } = backend();
    const running = { ...completed, running: true, exitCode: null };
    vi.mocked(api.runTask).mockResolvedValueOnce(running);
    let resolveStatus!: (result: TaskResult) => void;
    vi.mocked(api.taskStatus).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
    );
    const session = new WorkspaceRunSession('/project', api);
    await session.load();
    await session.run('first', '.');
    await vi.advanceTimersByTimeAsync(400);
    await session.stop();
    resolveStatus(running);
    await Promise.resolve();
    expect(session.getSnapshot().task?.running).toBe(false);
  });

  it('keeps a potentially running command blocked after transient status failure until stop succeeds', async () => {
    const { api } = backend();
    vi.mocked(api.runTask).mockResolvedValueOnce({ ...completed, running: true, exitCode: null });
    vi.mocked(api.taskStatus).mockRejectedValueOnce(new Error('Connection interrupted'));
    const session = new WorkspaceRunSession('/project', api);
    await session.load();
    await session.run('first', '.');
    await vi.advanceTimersByTimeAsync(400);
    expect(session.getSnapshot().task?.running).toBe(true);
    expect(await session.run('duplicate', '.')).toBe(false);
    await session.stop();
    expect(api.stopTask).toHaveBeenCalledWith('task-1');
    expect(await session.run('after stop', '.')).toBe(true);
  });
});
