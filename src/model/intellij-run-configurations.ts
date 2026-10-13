import type { IntelliJRunConfiguration } from './intellij-import-contracts';
import { relativeWorkingDirectory, type RunConfiguration } from './run-configurations';

// This personal build uses the user's explicitly configured SDK, never whichever `go` is on PATH.
const goBinary = '/Users/grejo.j/.gvm/gos/go1.25.5/bin/go';

export interface IntelliJRunConfigurationCandidate {
  id: string;
  name: string;
  type: string;
  status: 'ready' | 'unsupported' | 'duplicate';
  configuration?: RunConfiguration;
  notes: string[];
}

type Fields = IntelliJRunConfiguration['fields'];
const quote = (argument: string) => `'${argument.replaceAll("'", "'\\''")}'`;
const command = (arguments_: string[]) => arguments_.map(quote).join(' ');

function rootPath(value: string): string {
  if (!value.startsWith('/') || /[\\\0\r\n$]/.test(value) || value.split('/').includes('..'))
    throw new Error(
      'Choose an absolute project/workspace root without parent traversal or macros.',
    );
  return `/${value
    .split('/')
    .filter((part) => part && part !== '.')
    .join('/')}`;
}

function projectPath(value: string, originalRoot: string): string {
  if (value !== value.trim() || /[\0\r\n]/.test(value))
    throw new Error('A configuration path contains unsupported whitespace or control characters.');
  let path = value;
  if (path === '$PROJECT_DIR$' || path.startsWith('$PROJECT_DIR$/'))
    path =
      `${originalRoot === '/' ? '' : originalRoot}${path.slice('$PROJECT_DIR$'.length)}` || '/';
  if (path.includes('$'))
    throw new Error('A configuration path uses an unresolved IntelliJ macro.');
  if (path.startsWith('/')) {
    if (path === originalRoot) path = '.';
    else if (originalRoot === '/') path = path.slice(1);
    else if (path.startsWith(`${originalRoot}/`)) path = path.slice(originalRoot.length + 1);
    else throw new Error('A configuration path is outside the selected original project root.');
  }
  return relativeWorkingDirectory(path);
}

// ParametersListUtil's default parser recognizes double quotes and escaped double quotes;
// it is not a shell parser. Single-quote syntax differs between JetBrains consumers, so
// reject ambiguous single quotes outside double quotes rather than reinterpret them.
// https://github.com/JetBrains/intellij-community/blob/master/platform/util/src/com/intellij/util/execution/ParametersListUtil.java
function parameters(value = ''): string[] {
  if (/[\0\r\n]/.test(value))
    throw new Error('Multiline or NUL program arguments are unsupported.');
  const result: string[] = [];
  let token = '';
  let quoted = false;
  let started = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === '\\' && value[index + 1] === '"') {
      token += '"';
      started = true;
      index++;
    } else if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (char === "'" && !quoted) {
      throw new Error(
        'Single-quote argument syntax is ambiguous; use double quotes before importing.',
      );
    } else if (/\s/.test(char) && !quoted) {
      if (started) result.push(token);
      token = '';
      started = false;
    } else {
      token += char;
      started = true;
    }
  }
  if (quoted) throw new Error('Program arguments contain an unclosed double quote.');
  if (started) result.push(token);
  return result;
}

function programArguments(
  value: string | undefined,
  originalRoot: string,
  workspaceRoot: string,
): string[] {
  return parameters(value).map((argument) => {
    const marker = argument.indexOf('$PROJECT_DIR$');
    if (marker >= 0) {
      // Accept a standalone path or --option=path; don't expand arbitrary embedded macros.
      const prefix = argument.slice(0, marker);
      if (prefix !== '' && !/^--?[\w-]+=$/.test(prefix))
        throw new Error('A program argument embeds a project macro in an unsupported position.');
      const relative = projectPath(argument.slice(marker), originalRoot);
      const absolute =
        relative === '.'
          ? workspaceRoot
          : `${workspaceRoot === '/' ? '' : workspaceRoot}/${relative}`;
      return `${prefix}${absolute}`;
    }
    if (/\$[A-Za-z_][A-Za-z_0-9]*\$|\$\{/.test(argument))
      throw new Error('Program arguments contain an unresolved IntelliJ macro.');
    return argument;
  });
}

function onlyFields(fields: Fields, allowed: (keyof Fields)[]): void {
  for (const [name, value] of Object.entries(fields)) {
    if (
      !allowed.includes(name as keyof Fields) &&
      value !== undefined &&
      value !== '' &&
      !(Array.isArray(value) && value.length === 0)
    )
      throw new Error(`The ${name} setting cannot be represented for this configuration type.`);
  }
}

function npmConfiguration(
  row: IntelliJRunConfiguration,
  originalRoot: string,
  workspaceRoot: string,
  notes: string[],
): RunConfiguration {
  const fields = row.fields;
  onlyFields(fields, [
    'workingDirectory',
    'packageJson',
    'command',
    'scripts',
    'nodeInterpreter',
    'packageManager',
    'programParameters',
  ]);
  if (fields.command !== 'run' && fields.command !== 'run-script')
    throw new Error('Only npm run/run-script configurations can be imported.');
  if (
    !fields.scripts ||
    fields.scripts.length !== 1 ||
    !fields.scripts[0] ||
    fields.scripts[0].startsWith('-') ||
    /[\0\r\n]/.test(fields.scripts[0])
  )
    throw new Error('Choose exactly one nonempty npm script without a leading option prefix.');
  if (fields.nodeInterpreter && fields.nodeInterpreter !== 'project')
    throw new Error('A custom Node interpreter cannot be imported.');
  if (fields.packageManager && fields.packageManager !== 'npm')
    throw new Error(
      'A custom or unresolved project package manager cannot be imported; select npm explicitly.',
    );
  if (!fields.packageJson) throw new Error('The npm package.json path is missing.');
  const packageJson = projectPath(fields.packageJson, originalRoot);
  if (packageJson !== 'package.json' && !packageJson.endsWith('/package.json'))
    throw new Error('The npm configuration must target a package.json inside the workspace.');
  const directory =
    packageJson === 'package.json' ? '.' : packageJson.slice(0, -'/package.json'.length);
  if (fields.workingDirectory && projectPath(fields.workingDirectory, originalRoot) !== directory)
    throw new Error(
      'An npm working directory different from its package.json directory is unsupported.',
    );
  const args = programArguments(fields.programParameters, originalRoot, workspaceRoot);
  notes.push(
    'Runs with npm and Node available to the application shell; IntelliJ project runtime selection is not imported.',
  );
  return {
    id: `intellij-run-${row.id}`,
    name: row.name.trim(),
    workingDirectory: directory,
    command: command(['npm', 'run', fields.scripts[0], ...(args.length ? ['--', ...args] : [])]),
  };
}

function goConfiguration(
  row: IntelliJRunConfiguration,
  originalRoot: string,
  workspaceRoot: string,
  notes: string[],
): RunConfiguration {
  const fields = row.fields;
  onlyFields(fields, [
    'workingDirectory',
    'goKind',
    'filePath',
    'packagePath',
    'directoryPath',
    'programParameters',
    'goParameters',
    'pattern',
    'framework',
  ]);
  if (fields.goParameters?.trim())
    throw new Error('Custom Go tool arguments/build flags cannot be imported.');
  const test = row.type === 'GoTestRunConfiguration';
  if (fields.framework && fields.framework !== 'gotest')
    throw new Error('This Go test framework is unsupported.');
  if (!test && (fields.pattern || fields.framework))
    throw new Error('Test settings on a Go application configuration are unsupported.');
  if (!fields.workingDirectory) throw new Error('An explicit Go working directory is required.');
  const directory = projectPath(fields.workingDirectory, originalRoot);
  const kind = fields.goKind?.toUpperCase();
  if (kind !== 'DIRECTORY' && kind !== 'PACKAGE')
    throw new Error(
      'Only Go directory or local package configurations are supported; file scope is not equivalent.',
    );
  if (fields.filePath)
    throw new Error('An explicit Go file target cannot be imported as a whole package.');
  if (kind === 'DIRECTORY') {
    if (!fields.directoryPath || projectPath(fields.directoryPath, originalRoot) !== directory)
      throw new Error('The Go directory target must match the working directory for this import.');
    if (fields.packagePath && fields.packagePath !== '.')
      throw new Error('A Go directory configuration contains an unresolved package target.');
  } else {
    if (fields.packagePath !== '.')
      throw new Error('Only the local Go package path "." is currently supported.');
    if (fields.directoryPath && projectPath(fields.directoryPath, originalRoot) !== directory)
      throw new Error('The Go package directory and working directory disagree.');
  }
  const args = programArguments(fields.programParameters, originalRoot, workspaceRoot);
  const pattern = fields.pattern ?? '';
  if (/[\0\r\n]|\$[A-Za-z_][A-Za-z_0-9]*\$|\$\{/.test(pattern))
    throw new Error('The Go test pattern contains unsupported control characters or macros.');
  const recursive = test && kind === 'DIRECTORY';
  const testArgs = [
    ...(pattern ? ['-run', pattern] : []),
    ...(args.length ? ['-args', ...args] : []),
  ];
  const configuration: RunConfiguration = {
    id: `intellij-run-${row.id}`,
    name: row.name.trim(),
    workingDirectory: directory,
    command: command([
      '/usr/bin/env',
      `GOROOT=${goBinary.slice(0, -'/bin/go'.length)}`,
      'GOTOOLCHAIN=local',
      goBinary,
      test ? 'test' : 'run',
      recursive ? './...' : '.',
      ...(test ? testArgs : args),
    ]),
  };
  notes.push(`Go Run uses ${goBinary}; Debug uses the Go package's configured SDK.`);
  if (recursive) {
    // JetBrains directory tests include descendants. Delve can debug only one test package.
    // https://www.jetbrains.com/help/idea/go-plugin-run-debug-configurations.html
    notes.push(
      'Directory tests preserve recursive ./... scope. Recursive test debugging is unsupported; this configuration imports Run only.',
    );
  } else {
    configuration.debug = {
      provider: 'go',
      mode: test ? 'test' : 'debug',
      path: directory,
      workingDirectory: directory,
      args: [...(test && pattern ? ['-test.run', pattern] : []), ...args],
    };
  }
  return configuration;
}

/** Pure preview: no files, settings, processes, or connections are changed. */
export function previewIntelliJRunConfigurations(
  rows: IntelliJRunConfiguration[],
  originalProjectRoot: string,
  workspaceRoot: string,
  existing: RunConfiguration[],
): IntelliJRunConfigurationCandidate[] {
  const ids = new Set(existing.map((item) => item.id));
  const names = new Set(existing.map((item) => item.name));
  return rows.map((row) => {
    const candidate: IntelliJRunConfigurationCandidate = {
      id: row.id,
      name: row.name,
      type: row.type,
      status: 'unsupported',
      notes: [...row.notes],
    };
    if (row.status !== 'ready') return candidate;
    try {
      if (!row.id || !row.name.trim())
        throw new Error('The configuration name or identity is missing.');
      const originalRoot = rootPath(originalProjectRoot);
      const targetRoot = rootPath(workspaceRoot);
      let configuration: RunConfiguration;
      if (row.type === 'js.build_tools.npm')
        configuration = npmConfiguration(row, originalRoot, targetRoot, candidate.notes);
      else if (
        row.type === 'GoApplicationRunConfiguration' ||
        row.type === 'GoTestRunConfiguration'
      )
        configuration = goConfiguration(row, originalRoot, targetRoot, candidate.notes);
      else throw new Error('This IntelliJ run configuration type is unsupported.');
      if (ids.has(configuration.id) || names.has(configuration.name)) {
        candidate.status = 'duplicate';
        candidate.notes.push(
          'A configuration with this identity or name already exists in the workspace or this preview.',
        );
      } else {
        ids.add(configuration.id);
        names.add(configuration.name);
        candidate.status = 'ready';
        candidate.configuration = configuration;
        candidate.notes.push('Import saves this configuration only; it does not execute it.');
      }
    } catch (error) {
      candidate.notes.push(
        error instanceof Error ? error.message : 'This configuration could not be translated.',
      );
    }
    return candidate;
  });
}
