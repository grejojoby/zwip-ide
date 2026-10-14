import type { TaskResult } from '../contracts';

export interface RunConfiguration {
  id: string;
  name: string;
  command: string;
  workingDirectory: string;
  /** Variables added for Run and Debug, in order. Stored only in local app settings. */
  env?: EnvironmentVariable[];
  debug?: {
    provider: 'go';
    mode: 'debug' | 'test';
    path: string;
    workingDirectory: string;
    args: string[];
  };
}
export interface EnvironmentVariable {
  name: string;
  value: string;
}
export interface RunConfigurationSettings {
  version: 1;
  selectedId: string | null;
  configurations: RunConfiguration[];
}
export interface RunState {
  ready: boolean;
  settings: RunConfigurationSettings;
  saving: boolean;
  starting: boolean;
  task: TaskResult | null;
  taskLabel: string;
  /** What the running task executes, shown above its output like IntelliJ's console. */
  taskCommand?: { command: string; cwd: string; startedAt: number };
  error: string;
}
export interface RunBackend {
  getSetting<T>(key: string): Promise<T | null>;
  setSetting<T>(key: string, value: T): Promise<T>;
  runTask(command: string, cwd: string, env?: EnvironmentVariable[]): Promise<TaskResult>;
  taskStatus(id: string): Promise<TaskResult>;
  stopTask(id: string): Promise<void>;
}
export const runSettingsKey = (root: string) => `zwip.${root}.runConfigurations`;
const emptySettings = (): RunConfigurationSettings => ({
  version: 1,
  selectedId: null,
  configurations: [],
});
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function relativeWorkingDirectory(value: string): string {
  const path = value.trim();
  if (
    path.startsWith('/') ||
    path.startsWith('~') ||
    /^[A-Za-z]:/.test(path) ||
    /[\\\0\r\n]/.test(path) ||
    path.split('/').includes('..')
  )
    throw new Error(
      'Working directory must be relative to the workspace, without parent traversal.',
    );
  return (
    path
      .split('/')
      .filter((part) => part && part !== '.')
      .join('/') || '.'
  );
}
export function runDirectory(root: string, relativePath: string): string {
  const path = relativeWorkingDirectory(relativePath);
  return path === '.' ? root : `${root.replace(/\/+$/, '')}/${path}`;
}
const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function validateEnvironment(env: unknown): EnvironmentVariable[] {
  if (!Array.isArray(env)) throw new Error('Invalid environment variables.');
  const names = new Set<string>();
  return env.map((item: unknown) => {
    const name = (item as EnvironmentVariable | null)?.name;
    const value = (item as EnvironmentVariable | null)?.value;
    if (typeof name !== 'string' || !environmentName.test(name))
      throw new Error(`Invalid environment variable name: ${String(name)}`);
    if (typeof value !== 'string' || value.includes('\0'))
      throw new Error(`Invalid value for environment variable ${name}.`);
    if (names.has(name)) throw new Error(`Environment variable ${name} is set twice.`);
    names.add(name);
    return { name, value };
  });
}
/** One NAME=value per line; blank lines and # comments are ignored. */
export function parseEnvironment(text: string): EnvironmentVariable[] {
  return validateEnvironment(
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const split = line.indexOf('=');
        if (split < 1) throw new Error(`Use NAME=value for each environment variable: ${line}`);
        return { name: line.slice(0, split).trim(), value: line.slice(split + 1) };
      }),
  );
}
export function formatEnvironment(env: EnvironmentVariable[] = []): string {
  return env.map(({ name, value }) => `${name}=${value}`).join('\n');
}
export function validateConfiguration(config: RunConfiguration): RunConfiguration {
  if (
    typeof config.id !== 'string' ||
    !config.id ||
    typeof config.name !== 'string' ||
    !config.name.trim()
  )
    throw new Error('Enter a configuration name.');
  if (typeof config.command !== 'string' || !config.command.trim())
    throw new Error('Enter a command to run.');
  if (typeof config.workingDirectory !== 'string') throw new Error('Invalid working directory.');
  let debug: RunConfiguration['debug'];
  if (config.debug !== undefined) {
    const candidate = config.debug;
    if (
      !candidate ||
      candidate.provider !== 'go' ||
      (candidate.mode !== 'debug' && candidate.mode !== 'test') ||
      typeof candidate.path !== 'string' ||
      typeof candidate.workingDirectory !== 'string' ||
      !Array.isArray(candidate.args) ||
      candidate.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
    )
      throw new Error('Invalid Go debug configuration.');
    debug = {
      provider: 'go',
      mode: candidate.mode,
      path: relativeWorkingDirectory(candidate.path),
      args: [...candidate.args],
      workingDirectory: relativeWorkingDirectory(candidate.workingDirectory),
    };
  }
  const env = config.env === undefined ? [] : validateEnvironment(config.env);
  return {
    id: config.id,
    name: config.name.trim(),
    command: config.command,
    workingDirectory: relativeWorkingDirectory(config.workingDirectory),
    ...(env.length && { env }),
    ...(debug && { debug }),
  };
}
export function readRunSettings(value: unknown): RunConfigurationSettings {
  if (value === null) return emptySettings();
  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('configurations' in value) ||
    !Array.isArray(value.configurations) ||
    !('selectedId' in value)
  )
    throw new Error('Saved run configurations are invalid; they have not been overwritten.');
  const configurations = value.configurations.map((config) => validateConfiguration(config));
  if (new Set(configurations.map((config) => config.id)).size !== configurations.length)
    throw new Error('Saved run configurations contain duplicate IDs.');
  const selectedId =
    typeof value.selectedId === 'string' &&
    configurations.some((config) => config.id === value.selectedId)
      ? value.selectedId
      : null;
  return { version: 1, selectedId, configurations };
}

/** One workspace owns its immutable snapshots, persistence, and in-flight task.
 * Closing its panel cannot lose output or repeat a run. No task is auto-started on hydration. */
export class WorkspaceRunSession {
  private state: RunState = {
    ready: false,
    settings: emptySettings(),
    saving: false,
    starting: false,
    task: null,
    taskLabel: '',
    error: '',
  };
  private listeners = new Set<() => void>();
  private loading: Promise<void> | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private pollRevision = 0;
  constructor(
    readonly root: string,
    private backend: RunBackend,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(update: Partial<RunState>) {
    this.state = { ...this.state, ...update };
    for (const listener of this.listeners) listener();
  }
  load(): Promise<void> {
    if (!this.loading)
      this.loading = this.backend
        .getSetting<unknown>(runSettingsKey(this.root))
        .then((value) => this.update({ ready: true, settings: readRunSettings(value), error: '' }))
        .catch((error: unknown) => this.update({ error: message(error) }));
    return this.loading;
  }
  private async persist(settings: RunConfigurationSettings): Promise<boolean> {
    if (!this.state.ready || this.state.saving) return false;
    const previous = this.state.settings;
    this.update({ saving: true, error: '' });
    try {
      await this.backend.setSetting(runSettingsKey(this.root), settings);
      this.update({ settings, saving: false });
      return true;
    } catch (error) {
      this.update({ settings: previous, saving: false, error: message(error) });
      return false;
    }
  }
  select(id: string | null) {
    if (id !== null && !this.state.settings.configurations.some((config) => config.id === id))
      return Promise.resolve(false);
    return this.persist({ ...this.state.settings, selectedId: id });
  }
  async save(config: RunConfiguration): Promise<boolean> {
    try {
      const validated = validateConfiguration(config);
      const existing = this.state.settings.configurations;
      if (existing.some((item) => item.id !== config.id && item.name === validated.name))
        throw new Error('A run configuration already uses this name.');
      const configurations = existing.some((item) => item.id === config.id)
        ? existing.map((item) => (item.id === config.id ? validated : item))
        : [...existing, validated];
      return this.persist({ version: 1, selectedId: config.id, configurations });
    } catch (error) {
      this.update({ error: message(error) });
      return false;
    }
  }
  async importConfigurations(batch: RunConfiguration[]): Promise<boolean> {
    if (!this.state.ready || this.state.saving || !batch.length) return false;
    try {
      const configurations = [
        ...this.state.settings.configurations,
        ...batch.map(validateConfiguration),
      ];
      if (new Set(configurations.map((config) => config.id)).size !== configurations.length)
        throw new Error('A run configuration already uses this ID.');
      if (new Set(configurations.map((config) => config.name)).size !== configurations.length)
        throw new Error('A run configuration already uses this name.');
      return this.persist({ ...this.state.settings, configurations });
    } catch (error) {
      this.update({ error: message(error) });
      return false;
    }
  }
  remove(id: string) {
    return this.persist({
      version: 1,
      selectedId: this.state.settings.selectedId === id ? null : this.state.settings.selectedId,
      configurations: this.state.settings.configurations.filter((config) => config.id !== id),
    });
  }
  runSelected() {
    const config = this.state.settings.configurations.find(
      (config) => config.id === this.state.settings.selectedId,
    );
    return config
      ? this.run(config.command, config.workingDirectory, config.name, config.env)
      : Promise.resolve(false);
  }
  async run(
    command: string,
    directory: string,
    label = 'Ad hoc command',
    env: EnvironmentVariable[] = [],
  ): Promise<boolean> {
    if (!this.state.ready || this.state.saving || this.state.starting || this.state.task?.running)
      return false;
    this.update({ starting: true, error: '' });
    try {
      if (!command.trim()) throw new Error('Enter a command to run.');
      const cwd = runDirectory(this.root, directory);
      const variables = validateEnvironment(env);
      const task = variables.length
        ? await this.backend.runTask(command, cwd, variables)
        : await this.backend.runTask(command, cwd);
      this.update({
        task,
        taskLabel: label,
        taskCommand: { command, cwd, startedAt: Date.now() },
        starting: false,
      });
      this.schedulePoll();
      return true;
    } catch (error) {
      this.update({ starting: false, error: message(error) });
      return false;
    }
  }
  private schedulePoll() {
    clearTimeout(this.pollTimer);
    if (this.state.task?.running) this.pollTimer = setTimeout(() => void this.poll(), 400);
  }
  private async poll() {
    const id = this.state.task?.id;
    if (!id) return;
    const revision = ++this.pollRevision;
    try {
      const task = await this.backend.taskStatus(id);
      if (this.state.task?.id !== id || revision !== this.pollRevision) return;
      this.update({ task });
      this.schedulePoll();
    } catch (error) {
      if (this.state.task?.id !== id || revision !== this.pollRevision) return;
      this.taskError(id, error);
    }
  }
  private taskError(id: string, error: unknown) {
    if (this.state.task?.id !== id) return;
    const detail = message(error);
    this.update({
      error: detail,
      // Workspace changes remove Core tasks. Preserve captured output, but do
      // not leave a stale session permanently blocking subsequent runs.
      ...(detail === 'Task not found' && {
        task: { ...this.state.task, running: false, exitCode: null },
      }),
    });
  }
  async stop() {
    const id = this.state.task?.id;
    if (!id) return;
    try {
      await this.backend.stopTask(id);
      await this.poll();
    } catch (error) {
      this.taskError(id, error);
    }
  }
}
