import { browser, $ } from '@wdio/globals';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { updates } from '../../src/content/updates.ts';

const fixture = join(process.env.ZWIP_E2E_WORKSPACE, 'intellij-import-fixture');
const keymapPath = join(fixture, 'keymap.xml');
const sourcePath = join(fixture, 'connections.xml');
const zipPath = join(fixture, 'settings.zip');
const notesPath = join(fixture, 'notes.txt');
const runPath = join(fixture, 'native.run.xml');
const ranPath = join(fixture, 'ran-explicitly.txt');
const runSettingsKey = `zwip.${fixture}.runConfigurations`;
const initialNotes = 'Native IntelliJ import acceptance.\n';
const name = 'Imported native PostgreSQL';
const keymapXml = (key = 'meta shift P') =>
  `<keymap version="1" name="Native import" parent="Mac OS X 10.5+"><action id="GotoFile"><keyboard-shortcut first-keystroke="${key}" /></action></keymap>`;
const connectionsXml = (database = 'imported') =>
  `<project version="4"><component name="DataSourceManagerImpl" format="xml" multifile-model="true"><data-source source="LOCAL" name="${name}" uuid="native-import-postgres"><driver-ref>postgresql</driver-ref><jdbc-driver>org.postgresql.Driver</jdbc-driver><jdbc-url>jdbc:postgresql://127.0.0.1:1/${database}</jdbc-url><user-name>demo</user-name></data-source><data-source source="LOCAL" name="Unsupported native warehouse" uuid="native-import-unsupported"><driver-ref>oracle</driver-ref><jdbc-url>jdbc:oracle:thin:@localhost:1521:xe</jdbc-url><user-name>demo</user-name></data-source></component></project>`;
const call = async (method, params = {}) => {
  const reply = await browser.executeAsync(
    (method, params, done) => {
      window.__TAURI__.core.invoke('ide_request', { method, params }).then(
        (result) => done({ result }),
        (error) => done({ error: String(error) }),
      );
    },
    method,
    params,
  );
  if (reply.error) throw new Error(reply.error);
  return reply.result;
};
// The embedded driver option.click() does not perform a select's default
// action. Dispatch the same real DOM change consumed by React, as in desktop.mjs.
async function selectRunConfiguration(value) {
  assert.equal(
    await browser.execute((value) => {
      const select = document.querySelector('[aria-label="Run configuration"]');
      if (
        !(select instanceof HTMLSelectElement) ||
        !Array.from(select.options).some((option) => option.value === value)
      )
        return false;
      select.value = value;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, value),
    true,
  );
}
async function settings() {
  await $('footer').$('button=Settings').click();
  const dialog = $('dialog[aria-label="Settings"]');
  await dialog.waitForDisplayed();
  return dialog;
}
async function importPreview(path) {
  const settingsDialog = $('dialog[aria-label="Settings"]');
  await settingsDialog.$('button=Import from IntelliJ…').click();
  const dialog = $('dialog[aria-label="Import from IntelliJ"]');
  await dialog.waitForDisplayed();
  await dialog.$('input[placeholder="Absolute path to a settings file or folder"]').setValue(path);
  await dialog.$('button=Preview import').click();
  await dialog.$('.import-review').waitForDisplayed({ timeout: 20000 });
  return dialog;
}
async function preserveBuffer(expected) {
  const snapshot = await call('document.open', { path: notesPath });
  assert.equal(snapshot.content, expected);
  assert.equal(snapshot.dirty, true);
  assert.equal(readFileSync(notesPath, 'utf8'), initialNotes);
}
before(async () => {
  assert.ok(
    existsSync(join(process.env.ZWIP_E2E_WORKSPACE, '.zwip-e2e-fixture')),
    'IntelliJ import acceptance only writes beneath the disposable marked native fixture.',
  );
  mkdirSync(fixture, { recursive: true });
  writeFileSync(notesPath, initialNotes);
  writeFileSync(keymapPath, keymapXml());
  writeFileSync(sourcePath, connectionsXml());
  writeFileSync(
    join(fixture, 'package.json'),
    JSON.stringify({ private: true, scripts: { 'native-import': 'node native-run.mjs' } }),
  );
  writeFileSync(
    join(fixture, 'native-run.mjs'),
    "import {writeFileSync} from 'node:fs'; writeFileSync('ran-explicitly.txt','explicit npm run'); console.log('NATIVE_IMPORTED_RUN_OK');\n",
  );
  mkdirSync(join(fixture, 'api', 'cmd', 'server'), { recursive: true });
  writeFileSync(join(fixture, 'api', 'go.mod'), 'module example.com/importednative\n\ngo 1.25.5\n');
  writeFileSync(
    join(fixture, 'api', 'cmd', 'server', 'main.go'),
    'package main\nimport("fmt";"os")\nfunc main(){ cwd,_:=os.Getwd(); fmt.Println("NATIVE_IMPORTED_DEBUG_OK",cwd,os.Args[1:]) }\n',
  );
  writeFileSync(
    runPath,
    `<component name="ProjectRunConfigurationManager"><configuration name="Imported native npm" type="js.build_tools.npm"><package-json value="$PROJECT_DIR$/package.json"/><command value="run"/><scripts><script value="native-import"/></scripts><node-interpreter value="project"/><package-manager value="npm"/><method v="2"/></configuration><configuration name="Imported native Go" type="GoApplicationRunConfiguration"><working_directory value="$PROJECT_DIR$/api/cmd/server"/><kind value="DIRECTORY"/><directory value="$PROJECT_DIR$/api/cmd/server"/><parameters value="--message native"/><method v="2"/></configuration></component>`,
  );
  execFileSync('python3', [
    '-c',
    'import sys,zipfile,pathlib; p=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(p/"settings.zip","w",zipfile.ZIP_DEFLATED); z.write(p/"keymap.xml","keymaps/native.xml"); z.write(p/"connections.xml","options/dataSources.xml"); z.close()',
    fixture,
  ]);
  const [handle] = await browser.getWindowHandles();
  await browser.switchToWindow(handle);
  await browser.waitUntil(() => browser.execute(() => Boolean(window.__TAURI__?.core)));
  await call('settings.set', { key: 'zwip.updates.lastSeen', value: updates[0].id });
  await call('settings.set', { key: 'zwip.recentRoots', value: [fixture] });
  await browser.refresh();
  await $('.recent-projects button').waitForDisplayed();
  await $('.recent-projects button').click();
  await $('[aria-label="Filter project files"]').waitForDisplayed();
  await $('[role="treeitem"][title="notes.txt"]').waitForDisplayed();
  await $('[role="treeitem"][title="notes.txt"]').click();
  await $('[aria-label="Editor for notes.txt"]').waitForDisplayed();
});
afterEach(async function () {
  if (this.currentTest?.state === 'failed') {
    await browser
      .saveScreenshot(resolve('artifacts/native-intellij-import-failure.png'))
      .catch(() => {});
  }
});
describe('native IntelliJ settings import', () => {
  it('stages XML keybindings, keeps Cancel unchanged, and only applies a saved conflict-free draft', async () => {
    const editor = $('[aria-label="Editor for notes.txt"]');
    await editor.addValue('unsaved import buffer');
    await browser.waitUntil(async () => (await call('document.open', { path: notesPath })).dirty);
    const pending = (await call('document.open', { path: notesPath })).content;
    const original = await call('settings.get', { key: 'shortcuts' });
    await settings();
    let imported = await importPreview(keymapPath);
    assert.deepEqual(await call('settings.get', { key: 'shortcuts' }), original);
    await imported.$('button=Use reviewed keybindings').click();
    const settingsDialog = $('dialog[aria-label="Settings"]');
    await browser.waitUntil(async () => !(await imported.isExisting()));
    assert.match(await settingsDialog.$('[aria-label="Shortcut for Go to file"]').getText(), /P/);
    await settingsDialog.$('button=Cancel').click();
    assert.deepEqual(await call('settings.get', { key: 'shortcuts' }), original);
    await preserveBuffer(pending);

    writeFileSync(keymapPath, keymapXml('meta S'));
    await settings();
    imported = await importPreview(keymapPath);
    await imported.$('button=Use reviewed keybindings').click();
    await browser.waitUntil(async () => !(await imported.isExisting()));
    assert.equal(await settingsDialog.$('button=Save settings').isEnabled(), false);
    assert.match(await settingsDialog.getText(), /both use/);
    await settingsDialog.$('button=Cancel').click();
    assert.deepEqual(await call('settings.get', { key: 'shortcuts' }), original);

    writeFileSync(keymapPath, keymapXml());
    await settings();
    imported = await importPreview(keymapPath);
    await imported.$('button=Use reviewed keybindings').click();
    await browser.waitUntil(async () => !(await imported.isExisting()));
    await settingsDialog.$('button=Save settings').click();
    await browser.waitUntil(async () => !(await settingsDialog.isExisting()));
    assert.equal((await call('settings.get', { key: 'shortcuts' })).files, 'Mod-Shift-p');
    await preserveBuffer(pending);
    await editor.click();
    await browser.keys(['Meta', 'Shift', 'p']);
    const search = $('dialog[aria-label="Go to file"]');
    await search.waitForDisplayed();
    await browser.keys('Escape');
    await browser.waitUntil(async () => !(await search.isExisting()));
    await preserveBuffer(pending);
  });

  it('previews ZIP/XML, rejects a changed source, and imports connections without activation', async () => {
    const pending = (await call('document.open', { path: notesPath })).content;
    const currentShortcuts = await call('settings.get', { key: 'shortcuts' });
    const before = await call('connection.list');
    const packagesBefore = await call('package.list');
    await settings();
    let imported = await importPreview(zipPath);
    await imported.$('[aria-label="Keymap import"]').waitForDisplayed();
    await imported.$('[aria-label="Database connection import"]').waitForDisplayed();
    assert.equal(await imported.$('.import-connection:last-child input').isEnabled(), false);
    assert.deepEqual(await call('connection.list'), before);
    await imported.$('button=Back to Settings').click();
    imported = await importPreview(sourcePath);
    writeFileSync(sourcePath, connectionsXml('changed_after_preview'));
    await imported.$('button=Import 1 selected connection').click();
    await imported.$('[role="alert"]').waitForDisplayed();
    assert.match(await imported.$('[role="alert"]').getText(), /changed|stale|preview/i);
    assert.deepEqual(await call('connection.list'), before);
    assert.deepEqual(await call('settings.get', { key: 'shortcuts' }), currentShortcuts);
    await preserveBuffer(pending);
    await imported.$('button=Preview import').click();
    await imported.$('.import-review').waitForDisplayed();
    await imported.$('button=Import 1 selected connection').waitForEnabled();
    await imported.$('button=Import 1 selected connection').click();
    await imported.$('[role="status"]').waitForDisplayed();
    const connections = await call('connection.list');
    const entry = connections.find((item) => item.name === name);
    assert.ok(entry);
    assert.equal(entry.kind, 'postgres');
    assert.equal(entry.config.host, '127.0.0.1');
    assert.equal(entry.config.port, 1);
    assert.equal(entry.config.database, 'changed_after_preview');
    assert.equal(connections.length, before.length + 1);
    const packagesAfter = await call('package.list');
    assert.deepEqual(
      packagesAfter.map((item) => [item.id, item.running]),
      packagesBefore.map((item) => [item.id, item.running]),
    );
    assert.deepEqual(await call('settings.get', { key: 'shortcuts' }), currentShortcuts);
    await preserveBuffer(pending);
    await browser.saveScreenshot(resolve('artifacts/native-intellij-import.png'));
    await imported.$('button=Back to Settings').click();
    await $('dialog[aria-label="Settings"]').$('button=Cancel').click();
    await $('[aria-label="Database tools"]').click();
    const select = $('[aria-label="Saved database connection"]');
    await select.waitForDisplayed();
    await browser.waitUntil(async () => (await select.getText()).includes(name));
    assert.equal(await select.getValue(), '');
  });

  it('saves npm and Go configurations without starting them, then executes only an explicit Run', async () => {
    const pending = (await call('document.open', { path: notesPath })).content;
    const before = await call('settings.get', { key: runSettingsKey });
    const packagesBefore = await call('package.list');
    assert.equal(existsSync(ranPath), false);
    await settings();
    const imported = await importPreview(runPath);
    const section = imported.$('[aria-label="Run and debug configuration import"]');
    await section.waitForDisplayed();
    assert.deepEqual(await call('settings.get', { key: runSettingsKey }), before);
    const choices = await section.$$('input[type="checkbox"]');
    assert.equal(choices.length, 2);
    for (const choice of choices) {
      assert.equal(await choice.isSelected(), false);
      await choice.click();
    }
    await section.$('button=Import 2 selected run configurations').click();
    await imported.$('[role="status"]').waitForDisplayed();
    const saved = await call('settings.get', { key: runSettingsKey });
    assert.equal(saved.selectedId, before?.selectedId ?? null);
    const npm = saved.configurations.find((entry) => entry.name === 'Imported native npm');
    const go = saved.configurations.find((entry) => entry.name === 'Imported native Go');
    assert.ok(npm);
    assert.ok(go);
    assert.deepEqual(go.debug, {
      provider: 'go',
      mode: 'debug',
      path: 'api/cmd/server',
      workingDirectory: 'api/cmd/server',
      args: ['--message', 'native'],
    });
    assert.equal(existsSync(ranPath), false);
    assert.deepEqual(
      (await call('package.list')).map((item) => [item.id, item.running]),
      packagesBefore.map((item) => [item.id, item.running]),
    );
    await preserveBuffer(pending);
    await imported.$('button=Back to Settings').click();
    await $('dialog[aria-label="Settings"]').$('button=Cancel').click();
    await selectRunConfiguration(npm.id);
    await browser.waitUntil(
      async () => (await call('settings.get', { key: runSettingsKey })).selectedId === npm.id,
    );
    assert.equal(existsSync(ranPath), false);
    await $('[aria-label="Run selected configuration"]').click();
    await browser.waitUntil(() => existsSync(ranPath), { timeout: 20000 });
    assert.equal(readFileSync(ranPath, 'utf8'), 'explicit npm run');
    await browser.waitUntil(async () =>
      (await $('[aria-label="Task output"]').getText()).includes('NATIVE_IMPORTED_RUN_OK'),
    );
    await browser.waitUntil(
      async () => await $('[aria-label="Run selected configuration"]').isEnabled(),
    );
    await selectRunConfiguration(go.id);
    // Debug starts at once; without the Go package it reports the missing build context.
    await $('[aria-label="Debug selected configuration"]').waitForEnabled();
    await $('[aria-label="Debug selected configuration"]').click();
    const tools = $('[aria-label="Go tools"]');
    await tools.$('button=Debug prepared configuration').waitForDisplayed();
    assert.match(
      await tools.getText(),
      /Prepared Go debug target:.*\/api.*working directory:.*\/api.*--message/,
    );
    assert.equal(await tools.$('[aria-label="Go debugger"]').isExisting(), false);
    assert.deepEqual(
      (await call('package.list')).map((item) => [item.id, item.running]),
      packagesBefore.map((item) => [item.id, item.running]),
    );
    await preserveBuffer(pending);
    await $('[aria-label="Close Database tool"]').click();
    const resize = $('[aria-label="Resize tool panel"]');
    await resize.click();
    for (let step = 0; step < 12; step++) await browser.keys('ArrowUp');
    await browser.saveScreenshot(resolve('artifacts/native-intellij-run-import.png'));
    // Installing an owned fixture package is setup, not a substitute for the explicit UI launch.
    const installed = await call('package.install', { path: resolve('dist/packages/go') });
    assert.ok(installed.some((item) => item.id === 'go'));
    await call('package.enable', { id: 'go', enabled: true });
    await $('[aria-label="Filter project files"]').setValue('main.go');
    await $('[role="treeitem"][title$="/main.go"]').waitForDisplayed();
    await $('[role="treeitem"][title$="/main.go"]').click();
    await $('[aria-label="Editor for main.go"]').waitForDisplayed();
    await browser.waitUntil(
      async () => {
        const status = await call('workspace.status');
        const context = status.contexts.find((item) => item.root === join(fixture, 'api'));
        if (context?.state === 'failed') throw new Error(JSON.stringify(context));
        return context?.state === 'ready';
      },
      { timeout: 45000, timeoutMsg: 'Imported Go context did not finish indexing.' },
    );
    await tools.$('button=Debug prepared configuration').click();
    const debuggerPanel = $('section[aria-label="Go debugger"]');
    await debuggerPanel.waitForDisplayed();
    await browser.waitUntil(
      async () => {
        const errors = await debuggerPanel.$$('[role="alert"]');
        if (errors.length) throw new Error(await errors[0].getText());
        return /Exited|Terminated/.test(await debuggerPanel.$('.debug-toolbar strong').getText());
      },
      { timeout: 45000, timeoutMsg: 'Imported Go debug configuration did not finish.' },
    );
    await debuggerPanel.$('.debug-output summary').click();
    const output = await debuggerPanel.$('.debug-output pre').getText();
    assert.ok(
      output.includes(
        `NATIVE_IMPORTED_DEBUG_OK ${join(fixture, 'api', 'cmd', 'server')} [--message native]`,
      ),
      output,
    );
    await debuggerPanel.$('.debug-output pre').scrollIntoView();
    await browser.saveScreenshot(resolve('artifacts/native-intellij-debug-import.png'));
    await debuggerPanel.$('button=Stop debugger').click();
    await browser.waitUntil(async () => !(await debuggerPanel.isExisting()));
    await preserveBuffer(pending);
  });
});
