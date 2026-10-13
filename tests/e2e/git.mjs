import { browser, $ } from '@wdio/globals';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { updates } from '../../src/content/updates.ts';

const parent = dirname(process.env.ZWIP_E2E_WORKSPACE);
const partialRoot = join(parent, 'native-git');
const mergeRoot = join(parent, 'native-merge');
const remote = join(parent, 'native-remote.git');
const git = (root, ...args) =>
  execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
const lines = Array.from({ length: 24 }, (_, index) => `line ${index + 1}`);
const text = (changes) => lines.map((line, index) => changes[index + 1] ?? line).join('\n') + '\n';
function createRepository(root) {
  mkdirSync(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Native acceptance');
  git(root, 'config', 'user.email', 'native@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'core.hooksPath', join(root, '.git/empty-hooks'));
  mkdirSync(join(root, '.git/empty-hooks'));
  writeFileSync(join(root, '.zwip-e2e-fixture'), 'Disposable native Git acceptance repository.\n');
}
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
async function openRepository(root) {
  assert.ok(existsSync(join(root, '.zwip-e2e-fixture')));
  await call('settings.set', { key: 'zwip.recentRoots', value: [root] });
  await browser.refresh();
  await $('.recent-projects button').waitForDisplayed();
  await $('.recent-projects button').click();
  await $('[aria-label="Filter project files"]').waitForDisplayed();
  const gitButton = $('nav[aria-label="Right tool windows"]').$('button=Git');
  if ((await gitButton.getAttribute('aria-pressed')) !== 'true') await gitButton.click();
  await $('section[aria-label="Git changes"]').waitForDisplayed();
  await $('section[aria-label="Git changes"]').$('button=Refresh').waitForEnabled();
}
async function selectChangelist(name) {
  const value = await browser.execute((name) => {
    const select = document.querySelector('select[aria-label="Changelist"]');
    const option = Array.from(select.options).find((option) => option.textContent === name);
    if (!option) throw new Error(`Missing changelist ${name}`);
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return option.value;
  }, name);
  await browser.waitUntil(async () => (await $('[aria-label="Changelist"]').getValue()) === value);
}
async function newChangelist(name) {
  await $('.changelist-bar').$('button=New…').click();
  const dialog = $('dialog[aria-label="New changelist"]');
  await dialog.$('input').setValue(name);
  await dialog.$('button=Create changelist').click();
  await browser.waitUntil(async () => !(await dialog.isExisting()));
}
async function screenshot(name) {
  mkdirSync('artifacts', { recursive: true });
  await browser.saveScreenshot(resolve('artifacts', `native-${name}.png`));
}
before(async () => {
  assert.ok(
    existsSync(join(process.env.ZWIP_E2E_WORKSPACE, '.zwip-e2e-fixture')),
    'Native Git acceptance only creates repositories beside a disposable marked fixture.',
  );
  const [window] = await browser.getWindowHandles();
  await browser.switchToWindow(window);
  // The embedded service may preserve the app between serial spec workers.
  // openRepository refreshes to the welcome screen after writing its fixture.
  await browser.waitUntil(() => browser.execute(() => Boolean(window.__TAURI__?.core)));
  if ((await call('settings.get', { key: 'zwip.updates.lastSeen' })) !== updates[0].id) {
    const notes = $('dialog[aria-label="What’s new"]');
    await notes.waitForDisplayed();
    await notes.$('button=Got it').click();
    await browser.waitUntil(
      async () => (await call('settings.get', { key: 'zwip.updates.lastSeen' })) === updates[0].id,
    );
  }
  createRepository(partialRoot);
  writeFileSync(join(partialRoot, 'selected.txt'), text({}));
  writeFileSync(join(partialRoot, 'staged.txt'), 'staged original\n');
  writeFileSync(join(partialRoot, 'unstaged.txt'), 'unstaged original\n');
  git(partialRoot, 'add', '.');
  git(partialRoot, 'commit', '-m', 'Initial native fixture');
  git(parent, 'init', '--bare', remote);
  git(partialRoot, 'remote', 'add', 'origin', remote);
  git(partialRoot, 'push', '--set-upstream', 'origin', 'main');
  writeFileSync(
    join(partialRoot, 'selected.txt'),
    text({ 2: 'selected change', 18: 'remaining change' }),
  );
  writeFileSync(join(partialRoot, 'staged.txt'), 'staged in index\n');
  git(partialRoot, 'add', 'staged.txt');
  writeFileSync(join(partialRoot, 'staged.txt'), 'staged working copy\n');
  writeFileSync(join(partialRoot, 'unstaged.txt'), 'unstaged working copy\n');

  createRepository(mergeRoot);
  writeFileSync(join(mergeRoot, 'conflict.txt'), text({}));
  writeFileSync(join(mergeRoot, 'untouched.txt'), 'untouched original\n');
  git(mergeRoot, 'add', '.');
  git(mergeRoot, 'commit', '-m', 'Common ancestor');
  git(mergeRoot, 'switch', '-c', 'incoming');
  writeFileSync(
    join(mergeRoot, 'conflict.txt'),
    text({ 2: 'incoming conflict', 18: 'incoming independent' }),
  );
  git(mergeRoot, 'commit', '-am', 'Incoming side');
  git(mergeRoot, 'switch', 'main');
  writeFileSync(
    join(mergeRoot, 'conflict.txt'),
    text({ 2: 'current conflict', 8: 'current independent' }),
  );
  git(mergeRoot, 'commit', '-am', 'Current side');
  writeFileSync(join(mergeRoot, 'untouched.txt'), 'unrelated work preserved\n');
});
afterEach(async function () {
  if (this.currentTest?.state === 'failed') await screenshot('git-failure').catch(() => {});
});

describe('native Git daily workflows', () => {
  it('commits selected lines and reviews a push while preserving unrelated work', async () => {
    await openRepository(partialRoot);
    const panel = $('section[aria-label="Git changes"]');
    await panel.$('button[title="selected.txt"]').click();
    await screenshot('git-sidebar');
    await panel.$('[aria-label="Include remove at line 2"]').click();
    await panel.$('[aria-label="Include add at line 2"]').click();
    await newChangelist('First change');
    await panel.$('button=Clear selection').click();
    await selectChangelist('All changes');
    await panel.$('[aria-label="Include remove at line 18"]').click();
    await panel.$('[aria-label="Include add at line 18"]').click();
    await newChangelist('Later change');
    const lists = await call('git.changelists');
    assert.equal(
      lists.find((list) => list.name === 'First change').selections[0].changeIds.length,
      2,
    );
    assert.equal(
      lists.find((list) => list.name === 'Later change').selections[0].changeIds.length,
      2,
    );
    await selectChangelist('First change');
    await panel.$('button=Commit changes…').click();
    const review = $('dialog[aria-label="Review commit"]');
    await review.waitForDisplayed();
    assert.match(await review.$('.commit-sidebar').getText(), /Partial/);
    const excluded = await review.$$('.not-in-commit');
    assert.ok(
      (await excluded.map((line) => line.getText())).some((line) =>
        line.includes('remaining change'),
      ),
    );
    await review.$('textarea').setValue('Selected native lines');
    await screenshot('git-partial-commit');
    await review.$('button=Commit selected changes').click();
    await browser.waitUntil(async () => !(await review.isExisting()), { timeout: 20000 });
    assert.equal(git(partialRoot, 'show', 'HEAD:selected.txt'), text({ 2: 'selected change' }));
    assert.equal(git(partialRoot, 'show', ':selected.txt'), text({ 2: 'selected change' }));
    assert.equal(
      readFileSync(join(partialRoot, 'selected.txt'), 'utf8'),
      text({ 2: 'selected change', 18: 'remaining change' }),
    );
    assert.equal(git(partialRoot, 'show', ':staged.txt'), 'staged in index\n');
    assert.equal(readFileSync(join(partialRoot, 'staged.txt'), 'utf8'), 'staged working copy\n');
    assert.equal(
      readFileSync(join(partialRoot, 'unstaged.txt'), 'utf8'),
      'unstaged working copy\n',
    );
    assert.equal(
      git(partialRoot, 'show', '--format=', '--name-only', 'HEAD').trim(),
      'selected.txt',
    );
    await panel.$('button=Push…').click();
    const push = $('dialog[aria-label="Push overview"]');
    await push.waitForDisplayed();
    assert.match(await push.$('.push-destination').getText(), /origin\s*\/\s*main/);
    assert.match(await push.$('.push-commits').getText(), /Selected native lines/);
    const patch = await push.$('.patch-view').getText();
    assert.match(patch, /\+selected change/);
    assert.doesNotMatch(patch, /remaining change|staged in index|staged working copy/);
    await screenshot('git-push-overview');
    await push.$('button=Push 1 commits').click();
    await browser.waitUntil(async () => !(await push.isExisting()), { timeout: 20000 });
    assert.equal(
      git(remote, 'rev-parse', 'refs/heads/main'),
      git(partialRoot, 'rev-parse', 'HEAD'),
    );
    assert.equal(git(partialRoot, 'show', ':staged.txt'), 'staged in index\n');
    assert.equal(
      readFileSync(join(partialRoot, 'unstaged.txt'), 'utf8'),
      'unstaged working copy\n',
    );
  });

  it('resolves a three-pane merge and continues without discarding unrelated changes', async () => {
    await openRepository(mergeRoot);
    const panel = $('section[aria-label="Git changes"]');
    await panel.$('button=Branches…').click();
    const branches = $('dialog[aria-label="Git branches"]');
    await branches.waitForDisplayed();
    await branches.$('button*=incoming').click();
    await branches.$('button=Merge into main').click();
    await browser.waitUntil(async () => !(await branches.isExisting()), { timeout: 20000 });
    await panel.$('button=Resolve').waitForEnabled({ timeout: 20000 });
    assert.equal(git(mergeRoot, 'diff', '--name-only', '--diff-filter=U').trim(), 'conflict.txt');
    await panel.$('button=Resolve').click();
    const merge = $('dialog[aria-label="Resolve conflict · conflict.txt"]');
    await merge.waitForDisplayed();
    const panes = await merge.$$('.merge-pane');
    assert.equal(panes.length, 3);
    assert.match(await panes[0].getText(), /current conflict/);
    assert.match(await panes[2].getText(), /incoming conflict/);
    assert.match(await panes[0].$('.merge-pane-title').getText(), /main/);
    assert.match(await panes[2].$('.merge-pane-title').getText(), /incoming/);
    await merge.$('.merge-base summary').click();
    assert.match(await merge.$('.merge-base pre').getText(), /line 2/);
    await merge.$('button=Accept incoming').click();
    assert.match(await merge.$('.merge-toolbar').getText(), /0 unresolved/);
    await merge.$('button=Undo').click();
    assert.match(await merge.$('.merge-toolbar').getText(), /1 unresolved/);
    await merge.$('button=Accept incoming').click();
    const result = await merge.$('[aria-label="Merge result"]').getText();
    assert.match(result, /incoming conflict/);
    assert.match(result, /current independent/);
    assert.match(result, /incoming independent/);
    assert.doesNotMatch(result, /<<<<<<<|=======|>>>>>>>/);
    await screenshot('git-merge');
    await merge.$('button=Apply resolution').click();
    await browser.waitUntil(async () => !(await merge.isExisting()), { timeout: 20000 });
    assert.equal(git(mergeRoot, 'diff', '--name-only', '--diff-filter=U'), '');
    const expected = text({
      2: 'incoming conflict',
      8: 'current independent',
      18: 'incoming independent',
    });
    assert.equal(git(mergeRoot, 'show', ':conflict.txt'), expected);
    assert.equal(readFileSync(join(mergeRoot, 'conflict.txt'), 'utf8'), expected);
    await panel.$('button=Continue').waitForEnabled({ timeout: 10000 });
    await panel.$('button=Continue').click();
    await browser.waitUntil(() => !existsSync(join(mergeRoot, '.git/MERGE_HEAD')), {
      timeout: 20000,
    });
    assert.equal(
      git(mergeRoot, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ').length,
      3,
    );
    assert.equal(git(mergeRoot, 'show', 'HEAD:conflict.txt'), expected);
    assert.equal(
      readFileSync(join(mergeRoot, 'untouched.txt'), 'utf8'),
      'unrelated work preserved\n',
    );
    assert.equal(git(mergeRoot, 'show', ':untouched.txt'), 'untouched original\n');
  });
});
