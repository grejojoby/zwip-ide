import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { IntelliJRunConfiguration } from './intellij-import-contracts';
import { previewIntelliJRunConfigurations } from './intellij-run-configurations';
import type { RunConfiguration } from './run-configurations';

const npm = (
  fields: Partial<IntelliJRunConfiguration['fields']> = {},
): IntelliJRunConfiguration => ({
  id: 'source-npm',
  name: 'Web development',
  type: 'js.build_tools.npm',
  status: 'ready',
  notes: [],
  fields: {
    packageJson: '$PROJECT_DIR$/web/package.json',
    command: 'run',
    scripts: ['dev'],
    ...fields,
  },
});
const go = (
  fields: Partial<IntelliJRunConfiguration['fields']> = {},
  test = false,
): IntelliJRunConfiguration => ({
  id: 'source-go',
  name: 'Backend',
  type: test ? 'GoTestRunConfiguration' : 'GoApplicationRunConfiguration',
  status: 'ready',
  notes: [],
  fields: {
    workingDirectory: '$PROJECT_DIR$/server',
    goKind: 'DIRECTORY',
    directoryPath: '$PROJECT_DIR$/server',
    ...fields,
  },
});
const preview = (row: IntelliJRunConfiguration, existing: RunConfiguration[] = []) =>
  previewIntelliJRunConfigurations([row], '/original', '/workspace', existing)[0];

const expectUnsupported = (row: IntelliJRunConfiguration, reason: RegExp) => {
  const result = preview(row);
  expect(result.status).toBe('unsupported');
  expect(result.configuration).toBeUndefined();
  expect(result.notes.join('\n')).toMatch(reason);
};

describe('IntelliJ run configuration preview', () => {
  it('maps one npm script into a named saved command and relocates project paths', () => {
    const result = preview(
      npm({
        packageJson: '/original/web/package.json',
        command: 'run-script',
        nodeInterpreter: 'project',
      }),
    );
    expect(result.status).toBe('ready');
    expect(result.configuration).toEqual({
      id: 'intellij-run-source-npm',
      name: 'Web development',
      command: "'npm' 'run' 'dev'",
      workingDirectory: 'web',
    });
    expect(result.notes.join('\n')).toMatch(/does not execute/);
  });

  it('preserves argv, empty values and shell metacharacters without evaluating them', () => {
    const row = npm({
      programParameters:
        '--label "two words" "" "O\'Reilly" "$(printf injected)" "; printf unsafe" "--config=$PROJECT_DIR$/web/app config.json" "quoted \\"text\\""',
    });
    const result = preview(row);
    expect(result.status).toBe('ready');
    const output = execFileSync('/bin/sh', [
      '-c',
      `npm() { printf '%s\\0' "$@"; }; ${result.configuration!.command}`,
    ]);
    expect(output.toString().split('\0').slice(0, -1)).toEqual([
      'run',
      'dev',
      '--',
      '--label',
      'two words',
      '',
      "O'Reilly",
      '$(printf injected)',
      '; printf unsafe',
      '--config=/workspace/web/app config.json',
      'quoted "text"',
    ]);
  });

  it('preserves ordinary backslashes instead of applying shell escape rules', () => {
    const result = preview(npm({ programParameters: 'one\\two "three\\four"' }));
    expect(result.configuration?.command).toContain("'one\\two' 'three\\four'");
  });

  it('maps Go directory apps to the approved SDK and configured package debugger', () => {
    const result = preview(go({ programParameters: '--listen "127.0.0.1:9090" input.json' }));
    expect(result.status).toBe('ready');
    expect(result.configuration).toEqual({
      id: 'intellij-run-source-go',
      name: 'Backend',
      workingDirectory: 'server',
      command:
        "'/usr/bin/env' 'GOROOT=/Users/grejo.j/.gvm/gos/go1.25.5' 'GOTOOLCHAIN=local' '/Users/grejo.j/.gvm/gos/go1.25.5/bin/go' 'run' '.' '--listen' '127.0.0.1:9090' 'input.json'",
      debug: {
        provider: 'go',
        mode: 'debug',
        path: 'server',
        workingDirectory: 'server',
        args: ['--listen', '127.0.0.1:9090', 'input.json'],
      },
    });
    expect(result.notes.join('\n')).toMatch(/Debug uses the Go package's configured SDK/);
  });

  it('maps single-package Go test filters and arguments identically for run and debug', () => {
    const result = preview(
      go(
        {
          goKind: 'PACKAGE',
          packagePath: '.',
          pattern: '^TestHappy$/sub',
          framework: 'gotest',
          programParameters: '-test.v positional',
        },
        true,
      ),
    );
    expect(result.status).toBe('ready');
    expect(result.configuration?.command).toContain(
      "'test' '.' '-run' '^TestHappy$/sub' '-args' '-test.v' 'positional'",
    );
    expect(result.configuration?.debug).toEqual({
      provider: 'go',
      mode: 'test',
      path: 'server',
      workingDirectory: 'server',
      args: ['-test.run', '^TestHappy$/sub', '-test.v', 'positional'],
    });
  });

  it('preserves recursive directory-test scope and explicitly omits unsupported recursive debug', () => {
    const result = preview(go({ pattern: 'TestHappy' }, true));
    expect(result.status).toBe('ready');
    expect(result.configuration?.command).toContain("'test' './...' '-run' 'TestHappy'");
    expect(result.configuration?.debug).toBeUndefined();
    expect(result.notes.join('\n')).toMatch(/Recursive test debugging is unsupported/);
  });

  it('never re-enables backend-rejected environment or before-launch configurations', () => {
    const result = preview({
      ...npm(),
      status: 'unsupported',
      fields: {},
      notes: ['Custom environment and before-launch task unsupported.'],
    });
    expect(result.status).toBe('unsupported');
    expect(result.notes).toEqual(['Custom environment and before-launch task unsupported.']);
    expect(result.configuration).toBeUndefined();
  });

  it.each([
    [{ packageJson: '/outside/package.json' }, /outside/],
    [{ packageJson: '$PROJECT_DIR$/../other/package.json' }, /parent traversal/],
    [{ packageJson: '$MODULE_DIR$/package.json' }, /macro/],
    [{ packageJson: '$PROJECT_DIR$/web/not-package.json' }, /package.json/],
    [{ packageJson: 'C:\\repo\\package.json' }, /relative/],
    [{ workingDirectory: '$PROJECT_DIR$/other' }, /different/],
    [{ command: 'install' }, /run\/run-script/],
    [{ scripts: ['a', 'b'] }, /exactly one/],
    [{ scripts: ['--unsafe'] }, /option prefix/],
    [{ nodeInterpreter: '/custom/node' }, /custom Node/],
    [{ packageManager: 'yarn' }, /package manager/],
    [{ packageManager: 'project' }, /package manager/],
    [{ goParameters: '-tags=dev' }, /goParameters/],
    [{ programParameters: '"unclosed' }, /unclosed/],
    [{ programParameters: "'two words'" }, /Single-quote/],
    [{ programParameters: '$MODULE_DIR$/data' }, /macro/],
    [{ programParameters: '$PROJECT_DIR$/../outside' }, /parent traversal/],
  ] satisfies [Partial<IntelliJRunConfiguration['fields']>, RegExp][])(
    'rejects unsupported npm settings %j',
    (fields, reason) => {
      expectUnsupported(npm(fields), reason);
    },
  );

  it.each([
    [{ goParameters: '-tags=integration' }, /tool arguments/],
    [{ goKind: 'FILE', filePath: '$PROJECT_DIR$/server/main.go' }, /file scope/],
    [{ filePath: '$PROJECT_DIR$/server/main.go' }, /file target/],
    [{ workingDirectory: '$PROJECT_DIR$/other' }, /target must match/],
    [{ goKind: 'PACKAGE', packagePath: 'example.com/remote' }, /local Go package/],
    [{ goKind: 'PACKAGE', packagePath: './...' }, /local Go package/],
    [{ workingDirectory: '' }, /explicit Go working/],
    [{ framework: 'gocheck' }, /framework/],
    [{ nodeInterpreter: 'project' }, /nodeInterpreter/],
  ] satisfies [Partial<IntelliJRunConfiguration['fields']>, RegExp][])(
    'rejects unsupported Go settings %j',
    (fields, reason) => {
      expectUnsupported(go(fields), reason);
    },
  );

  it('detects duplicate identities and names against saved settings and other candidates', () => {
    const first = preview(npm()).configuration!;
    expect(preview(npm(), [first]).status).toBe('duplicate');
    const rows = previewIntelliJRunConfigurations(
      [npm(), { ...npm(), id: 'other-id' }],
      '/original',
      '/workspace',
      [],
    );
    expect(rows.map((row) => row.status)).toEqual(['ready', 'duplicate']);
    expect(rows[1].configuration).toBeUndefined();
  });

  it('requires an explicit absolute original project root and preserves input snapshots', () => {
    const row = npm();
    const before = structuredClone(row);
    expect(previewIntelliJRunConfigurations([row], '', '/workspace', [])[0].status).toBe(
      'unsupported',
    );
    const result = previewIntelliJRunConfigurations(
      [row],
      '/original/',
      '/different workspace/',
      [],
    );
    expect(result[0].status).toBe('ready');
    expect(row).toEqual(before);
  });
});
