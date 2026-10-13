import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
if (!process.env.ZWIP_E2E_WORKSPACE) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'zwip-e2e-')));
  const workspace = join(directory, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, '.zwip-e2e-fixture'), 'Disposable native acceptance workspace.\n');
  writeFileSync(
    join(workspace, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022' }, include: ['*.ts'] }),
  );
  writeFileSync(
    join(workspace, 'types.ts'),
    'export interface Service { run(): void }\nexport class Worker implements Service { run() {} }\nexport class OtherWorker implements Service { run() {} }\n',
  );
  writeFileSync(
    join(workspace, 'consumer.ts'),
    "import { Worker } from './types';\nnew Worker().run();\n",
  );
  writeFileSync(join(workspace, 'go.mod'), 'module example.com/nativefixture\n\ngo 1.25.5\n');
  writeFileSync(
    join(workspace, '.zwip.json'),
    JSON.stringify({
      version: 1,
      buildProfiles: [
        {
          id: 'native-profile',
          language: 'go',
          configPaths: ['go.mod'],
          settings: { tags: ['native_acceptance'] },
        },
      ],
    }),
  );
  writeFileSync(
    join(workspace, 'profile.go'),
    '//go:build native_acceptance\n\npackage main\n\nfunc ProfileOnly() string { return "profile" }\nfunc ProfileCaller() string { return ProfileOnly() }\n',
  );
  writeFileSync(
    join(workspace, 'main.go'),
    'package main\n\nimport "fmt"\n\nfunc Greeting() string { return "native" }\nfunc main() {\n\tlocal := Greeting()\n\tfmt.Println(local)\n\tlocal = "after"\n\tfmt.Println(local)\n}\n',
  );
  writeFileSync(
    join(workspace, 'main_test.go'),
    'package main\n\nimport "testing"\n\nfunc TestGreeting(t *testing.T) { if Greeting() != "native" { t.Fatal("greeting") } }\n',
  );
  process.env.ZWIP_DATA = join(directory, 'data');
  process.env.ZWIP_E2E_WORKSPACE = workspace;
}
export const config = {
  runner: 'local',
  specs: ['./tests/e2e/**/*.mjs'],
  maxInstances: 1,
  bail: 1,
  capabilities: [
    { browserName: 'tauri', 'tauri:options': { application: resolve('target/debug/zwip') } },
  ],
  services: [
    [
      '@wdio/tauri-service',
      {
        driverProvider: 'embedded',
        appBinaryPath: resolve('target/debug/zwip'),
        embeddedPort: 4457,
      },
    ],
  ],
  framework: 'mocha',
  reporters: ['spec'],
  logLevel: 'warn',
  mochaOpts: { timeout: 120000, bail: true },
  // A timed-out script may already have mutated native state. Retrying it can
  // duplicate package installs or file operations and hide the original fault.
  connectionRetryCount: 0,
};
