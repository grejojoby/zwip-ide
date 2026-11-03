import { browser, $ } from '@wdio/globals';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { updates } from '../../src/content/updates.ts';

const executable = resolve(process.env.ZWIP_E2E_APP ?? 'target/debug/zwip');
const bundle = executable.includes('.app/Contents/MacOS/')
  ? executable.split('/Contents/MacOS/')[0]
  : null;

describe('native command-line tool', () => {
  before(async () => {
    const [handle] = await browser.getWindowHandles();
    await browser.switchToWindow(handle);
    await $('h1').waitForDisplayed();
    const lastSeen = await browser.executeAsync((done) => {
      window.__TAURI__.core
        .invoke('ide_request', { method: 'settings.get', params: { key: 'zwip.updates.lastSeen' } })
        .then(done);
    });
    if (lastSeen !== updates[0].id) {
      const notes = $('dialog[aria-label="What’s new"]');
      await notes.waitForDisplayed();
      await notes.$('button=Got it').click();
    }
  });

  it('shows installation availability and readable terminal instructions in Settings', async () => {
    await $('button=Settings').click();
    const settings = $('dialog[aria-label="Settings"]');
    await settings.waitForDisplayed();
    const section = settings.$('.settings-section');
    assert.match(await section.getText(), /Command-line tool/);
    if (bundle) {
      await section.$('button=Install zwip command').waitForEnabled();
    } else {
      await browser.waitUntil(async () =>
        (await section.getText()).includes('Open a built Zwip.app'),
      );
    }
    await section.$('summary=Terminal setup instructions').click();
    assert.match(await section.getText(), /export PATH="\$HOME\/\.local\/bin:\$PATH"/);
    mkdirSync('artifacts', { recursive: true });
    await browser.saveScreenshot(resolve('artifacts/native-command-line-settings.png'));
    await settings.$('button=Cancel').click();
  });

  it('delivers macOS folder and file requests to the same workspace window', async function () {
    if (!bundle) this.skip();
    const root = process.env.ZWIP_E2E_WORKSPACE;
    const directory = join(root, 'CLI project é');
    mkdirSync(join(directory, 'src'), { recursive: true });
    const file = join(directory, 'src', "a file ' $.txt");
    writeFileSync(file, 'Opened through the command-line launcher.\n');
    execFileSync('/usr/bin/open', ['-a', bundle, '--', directory]);
    await browser.waitUntil(async () =>
      (await $('.project-button').getText()).includes('CLI project é'),
    );
    const handles = await browser.getWindowHandles();
    execFileSync('/usr/bin/open', ['-a', bundle, '--', file]);
    await $('[aria-label="Editor for a file \' $.txt"]').waitForDisplayed();
    assert.deepEqual(await browser.getWindowHandles(), handles);
    assert.match(await $('.project-button').getText(), /CLI project é/);
    await browser.saveScreenshot(resolve('artifacts/native-command-line-file.png'));
  });
});
