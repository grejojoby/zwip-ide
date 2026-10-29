import { browser, $, $$ } from '@wdio/globals';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const base = join(process.env.ZWIP_E2E_WORKSPACE, 'incoming-fixture');
const root = join(base, 'repo'),
  origin = join(base, 'origin.git'),
  writer = join(base, 'writer');
const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const identity = (dir) => {
  git(dir, 'config', 'user.name', 'Native fixture');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  git(dir, 'config', 'commit.gpgsign', 'false');
};
const advance = (branch, file) => {
  git(writer, 'switch', branch);
  writeFileSync(join(writer, file), file);
  git(writer, 'add', '.');
  git(writer, 'commit', '-m', file);
  git(writer, 'push', 'origin', branch);
};
const call = async (method, params = {}) => {
  const reply = await browser.executeAsync(
    (method, params, done) =>
      window.__TAURI__.core.invoke('ide_request', { method, params }).then(
        (result) => done({ result }),
        (error) => done({ error: String(error) }),
      ),
    method,
    params,
  );
  assert.ok(!reply.error, reply.error);
  return reply.result;
};
async function branches() {
  await browser.execute(() =>
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'b', metaKey: true, shiftKey: true, bubbles: true }),
    ),
  );
  const dialog = $('dialog[aria-label^="Git Branches in"]');
  await dialog.waitForDisplayed();
  return dialog;
}
before(async () => {
  assert.ok(existsSync(join(process.env.ZWIP_E2E_WORKSPACE, '.zwip-e2e-fixture')));
  for (const dir of [root, origin, writer]) mkdirSync(dir, { recursive: true });
  git(origin, 'init', '--bare', '-b', 'main');
  git(root, 'init', '-b', 'main');
  identity(root);
  writeFileSync(join(root, 'base.txt'), 'base');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', '-u', 'origin', 'main');
  git(root, 'switch', '-c', 'topic');
  git(root, 'push', '-u', 'origin', 'topic');
  git(root, 'switch', 'main');
  git(writer, 'clone', origin, '.');
  identity(writer);
  advance('topic', 'incoming-topic.txt');
  await call('settings.set', { key: 'zwip.recentRoots', value: [root] });
  await browser.refresh();
  await $('.recent-projects button').waitForDisplayed();
  // Acknowledge the running binary's update, even if source history changed after its build.
  const notes = $('dialog[aria-label="What’s new"]');
  if (!(await notes.isDisplayed())) await $('button[aria-label="What’s new"]').click();
  await notes.waitForDisplayed();
  await notes.$('button=Got it').click();
  await browser.waitUntil(async () => !(await notes.isExisting()));
  await $('.recent-projects button').click();
  await $('[aria-label="Filter project files"]').waitForDisplayed();
});
afterEach(async function () {
  if (this.currentTest?.state === 'failed') {
    mkdirSync('artifacts', { recursive: true });
    await browser.saveScreenshot(resolve('artifacts/native-incoming-failure.png'));
    console.log('Remote status at failure', await call('git.remoteStatus'));
  }
});
describe('native incoming branch updates', () => {
  it('focuses branch navigation on open and supports arrows before searching', async () => {
    await $('.branch-button').click();
    const dialog = $('dialog[aria-label^="Git Branches in"]');
    await dialog.waitForDisplayed();
    await browser.waitUntil(async () =>
      browser.execute(
        () =>
          document.activeElement?.getAttribute('role') === 'listbox' &&
          document.querySelector('.branch-popup')?.getAttribute('aria-busy') === 'false',
      ),
    );
    const selected = () => dialog.$('[role="option"][aria-selected="true"]');
    await browser.keys('ArrowDown');
    assert.match(await selected().getText(), /main/);
    await browser.keys('ArrowDown');
    assert.match(await selected().getText(), /topic/);
    await browser.keys('ArrowUp');
    assert.match(await selected().getText(), /main/);
    await browser.keys('ArrowRight');
    await dialog.$('[role="menu"][aria-label="Actions for main"]').waitForDisplayed();
    await browser.keys('ArrowLeft');
    assert.equal(
      await browser.execute(() => document.activeElement?.getAttribute('role')),
      'listbox',
    );
    await browser.keys('top');
    assert.equal(await dialog.$('[aria-label="Filter branches"]').getValue(), 'top');
    await browser.keys('ArrowDown');
    assert.match(await selected().getText(), /topic/);
    await dialog.$('button[aria-label^="Close Git Branches"]').click();
    await browser.waitUntil(async () => !(await dialog.isExisting()));
  });
  it('shows incoming icons with Git closed, then fetches every branch after checkout and pull', async () => {
    const toolbarBadge = $('.branch-button [role="img"]');
    await toolbarBadge.waitForDisplayed({ timeout: 20000 });
    assert.equal(await toolbarBadge.getAttribute('aria-label'), 'Updates to pull on 1 branch');
    await $('.branch-button').click();
    let dialog = $('dialog[aria-label^="Git Branches in"]');
    await dialog.waitForDisplayed();
    assert.match(await dialog.getText(), /1 branch has incoming changes/);
    await dialog.$('[aria-label="1 incoming commit from origin/topic"]').waitForDisplayed();
    mkdirSync('artifacts', { recursive: true });
    await browser.saveScreenshot(resolve('artifacts/native-incoming-branches.png'));
    advance('main', 'incoming-main.txt');
    await dialog.$('button[role="option"]').isExisting();
    const topic = dialog.$('//button[@role="option"][span[text()="topic"]]');
    await topic.click();
    await $('[role="menu"][aria-label="Actions for topic"]').$('button=Checkout').click();
    await browser.waitUntil(async () => !(await dialog.isExisting()));
    await browser.waitUntil(
      async () =>
        (await toolbarBadge.getAttribute('aria-label')) === 'Updates to pull on 2 branches',
      { timeout: 20000 },
    );
    assert.equal(git(root, 'branch', '--show-current'), 'topic');
    assert.equal(readFileSync(join(root, 'base.txt'), 'utf8'), 'base');
    const gitTool = $('nav[aria-label="Right tool windows"]').$('button=Git');
    if ((await gitTool.getAttribute('aria-pressed')) !== 'true') await gitTool.click();
    const panel = $('section[aria-label="Git changes"]');
    await panel.waitForDisplayed();
    const pull = panel.$('button=Pull (fast-forward)');
    await pull.waitForEnabled();
    await pull.click();
    await browser.waitUntil(
      async () => {
        const messages = await Promise.all(
          (await $$('.git-notification-success')).map((item) => item.getText()),
        );
        return messages.some((message) => message.includes("Branch 'topic' updated."));
      },
      { timeout: 20000 },
    );
    await browser.waitUntil(
      async () => (await toolbarBadge.getAttribute('aria-label')) === 'Updates to pull on 1 branch',
      { timeout: 20000 },
    );
    assert.ok(existsSync(join(root, 'incoming-topic.txt')));
    dialog = await branches();
    assert.match(await dialog.getText(), /1 branch has incoming changes/);
    assert.equal(
      await dialog.$('[aria-label="1 incoming commit from origin/topic"]').isExisting(),
      false,
    );
  });
});
