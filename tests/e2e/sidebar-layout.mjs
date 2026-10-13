import { browser, $ } from '@wdio/globals';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { updates } from '../../src/content/updates.ts';

const root = join(dirname(process.env.ZWIP_E2E_WORKSPACE), 'native-sidebar');
const source = join(root, 'folder', 'source.txt');
const databasePath = join(root, 'sidebar.sqlite');
const settingsKey = `zwip.${root}.sidebarLayout`;
const git = (...args) =>
  execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
async function call(method, params = {}) {
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
}
const rail = (side) => $(`nav[data-sidebar-side="${side}"]`);
const tab = (side, tool) => rail(side).$(`[data-sidebar-tool="${tool}"]`);
const host = (tool) => $(`#sidebar-panel-${tool}`);
async function moveWithMenu(tool, side) {
  await $(`[aria-label="Move ${tool}"]`).click();
  const dialog = $(`dialog[aria-label="Move ${tool}"]`);
  await dialog.waitForDisplayed();
  await dialog.$(`button=Move to ${side} sidebar`).click();
  await browser.waitUntil(async () => !(await dialog.isExisting()));
}
async function selectValue(selector, value) {
  assert.equal(
    await browser.execute(
      (selector, value) => {
        const element = document.querySelector(selector);
        if (
          !(element instanceof HTMLSelectElement) ||
          !Array.from(element.options).some((option) => option.value === value)
        )
          return false;
        element.value = value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      },
      selector,
      value,
    ),
    true,
  );
}
async function screenshot(name) {
  await browser.saveScreenshot(resolve(`artifacts/native-sidebar-${name}.png`));
}
// The embedded WebDriver 1.5.0 dispatches untrusted MouseEvents for pointer
// Actions, which cannot initiate WKWebView's native HTML drag operation. Real
// pointer qualification is captured separately with native input; this suite
// exercises the visible Move menus through the real app. Shift+F10 is covered
// in component tests; this driver also drops modifiers on special keys.
before(async () => {
  assert.ok(existsSync(join(process.env.ZWIP_E2E_WORKSPACE, '.zwip-e2e-fixture')));
  mkdirSync(join(root, 'folder'), { recursive: true });
  writeFileSync(join(root, '.zwip-e2e-fixture'), 'Disposable native sidebar repository.\n');
  writeFileSync(source, 'Original editor buffer.\n');
  writeFileSync(join(root, 'changed.txt'), 'Original Git line.\n');
  git('init', '-b', 'main');
  git('config', 'user.name', 'Native acceptance');
  git('config', 'user.email', 'native@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', join(root, '.git/empty-hooks'));
  mkdirSync(join(root, '.git/empty-hooks'));
  git('add', '.');
  git('commit', '-m', 'Sidebar fixture');
  writeFileSync(join(root, 'changed.txt'), 'Changed Git line.\n');
  const db = new DatabaseSync(databasePath);
  db.exec(
    "CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT NOT NULL); INSERT INTO people VALUES(1,'Original row');",
  );
  db.close();
  const [window] = await browser.getWindowHandles();
  await browser.switchToWindow(window);
  await browser.waitUntil(() => browser.execute(() => Boolean(window.__TAURI__?.core)));
  await call('settings.set', { key: 'zwip.updates.lastSeen', value: updates[0].id });
  await call('settings.set', { key: 'zwip.recentRoots', value: [root] });
  await browser.refresh();
  await $('.recent-projects button').waitForDisplayed();
  await $('.recent-projects button').click();
  await host('project').waitForDisplayed();
});
afterEach(async function () {
  if (this.currentTest?.state === 'failed') await screenshot('failure').catch(() => {});
});

describe('native movable sidebar windows', () => {
  it('moves Git beside Project, switches their panels and preserves Git drafts, tree state and editor buffers', async () => {
    await $('[role="treeitem"][title="folder"]').click();
    await $('[role="treeitem"][title="folder/source.txt"]').click();
    const editor = $('[aria-label="Editor for source.txt"]');
    await editor.waitForDisplayed();
    await editor.addValue('Uncommitted editor edit. ');
    await browser.waitUntil(async () => (await call('document.open', { path: source })).dirty);
    const originalBuffer = (await call('document.open', { path: source })).content;
    await $('[aria-label="Filter project files"]').setValue('source');
    await tab('right', 'git').click();
    const panel = $('section[aria-label="Git changes"]');
    await panel.waitForDisplayed();
    await panel.$('button[title="changed.txt"]').waitForDisplayed();
    await panel.$('button[title="changed.txt"]').click();
    await panel.$('[aria-label="Include changed.txt in commit"]').click();
    await panel.$('button=Commit changes…').click();
    let review = $('dialog[aria-label="Review commit"]');
    await review.waitForDisplayed();
    await review.$('textarea').setValue('Preserved sidebar commit draft');
    await review.$('button=Cancel').click();
    await browser.execute(() => {
      window.__sidebarGitHost = document.getElementById('sidebar-panel-git');
      window.__sidebarProjectHost = document.getElementById('sidebar-panel-project');
    });
    await moveWithMenu('Git', 'left');
    assert.equal(await host('git').isDisplayed(), true);
    assert.equal(await host('project').isDisplayed(), false);
    assert.match(await panel.getText(), /Changed Git line/);
    await tab('left', 'project').click();
    assert.equal(await $('[aria-label="Filter project files"]').getValue(), 'source');
    await $('[aria-label="Filter project files"]').setValue('');
    await $('[role="treeitem"][title="folder/source.txt"]').waitForDisplayed();
    await tab('left', 'git').click();
    await panel.$('button=Commit changes…').click();
    review = $('dialog[aria-label="Review commit"]');
    await review.waitForDisplayed();
    assert.equal(await review.$('textarea').getValue(), 'Preserved sidebar commit draft');
    await review.$('button=Cancel').click();
    assert.equal(
      await browser.execute(
        () =>
          window.__sidebarGitHost === document.getElementById('sidebar-panel-git') &&
          window.__sidebarProjectHost === document.getElementById('sidebar-panel-project'),
      ),
      true,
    );
    assert.equal((await call('document.open', { path: source })).content, originalBuffer);
    assert.equal(readFileSync(source, 'utf8'), 'Original editor buffer.\n');
    assert.equal(git('log', '--format=%s', '-1').trim(), 'Sidebar fixture');
    await screenshot('git-left');
  });

  it('moves Project, persists the layout and restores it after reopening', async () => {
    await tab('left', 'project').click();
    await moveWithMenu('Project', 'right');
    await host('project').waitForDisplayed();
    assert.equal(await host('project').getAttribute('data-sidebar-side'), 'right');
    await tab('left', 'git').click();
    await browser.waitUntil(async () => {
      const saved = await call('settings.get', { key: settingsKey });
      return (
        saved?.placements?.project === 'right' &&
        saved?.placements?.git === 'left' &&
        saved?.active?.left === 'git' &&
        saved?.active?.right === 'project'
      );
    });
    const saved = await call('settings.get', { key: settingsKey });
    // Explicit save precedes reopening; sidebar actions above must not save implicitly.
    await $('[aria-label="Editor for source.txt"]').click();
    await browser.keys(['Meta', 's']);
    await browser.waitUntil(async () => !(await call('document.open', { path: source })).dirty);
    await browser.refresh();
    await $('.recent-projects button').waitForDisplayed();
    await $('.recent-projects button').click();
    await host('project').waitForDisplayed();
    await host('git').waitForDisplayed();
    assert.equal(await host('project').getAttribute('data-sidebar-side'), 'right');
    assert.equal(await host('git').getAttribute('data-sidebar-side'), 'left');
    assert.deepEqual(await call('settings.get', { key: settingsKey }), saved);
    await screenshot('restored');
    await browser.setWindowSize(900, 700);
    const bounds = await browser.execute(() => ({
      width: innerWidth,
      rails: Array.from(document.querySelectorAll('nav[data-sidebar-side]')).map((element) => {
        const box = element.getBoundingClientRect();
        return { x: box.x, right: box.right, width: box.width };
      }),
      panels: ['project', 'git'].map((tool) => {
        const box = document.getElementById(`sidebar-panel-${tool}`).getBoundingClientRect();
        return { tool, x: box.x, right: box.right, width: box.width };
      }),
    }));
    assert.ok(bounds.width <= 900, JSON.stringify(bounds));
    for (const box of [...bounds.rails, ...bounds.panels])
      assert.ok(
        box.width > 0 && box.x >= -1 && box.right <= bounds.width + 1,
        JSON.stringify(bounds),
      );
    await screenshot('narrow');
    await browser.setWindowSize(1440, 900);
  });

  it('transfers pending database edits intact, guards hiding them, and moves an HTTP request intact', async () => {
    await call('package.install', { path: resolve('dist/packages/sql') });
    await call('package.enable', { id: 'sql', enabled: true });
    await tab('right', 'database').click();
    await $('[aria-label="Saved database connection"]').waitForDisplayed();
    await $('.database-panel').$('button=New…').click();
    const connection = $('dialog[aria-label="New database connection"]');
    await connection.waitForDisplayed();
    await connection.$('input[placeholder="Connection name"]').setValue('Sidebar SQLite');
    await selectValue('dialog[aria-label="New database connection"] select', 'sqlite');
    await connection.$('input[placeholder="/path/to/database.sqlite"]').setValue(databasePath);
    await connection.$('button=Save connection').click();
    const tables = $('[aria-label="Database table"]');
    await tables.waitForDisplayed();
    await browser.waitUntil(async () => (await tables.getHTML()).includes('.people'), {
      timeout: 20000,
    });
    await selectValue('[aria-label="Database table"]', '.people');
    await $('[aria-label="Edit row 1 name"]').waitForDisplayed();
    await $('[aria-label="Edit row 1 name"]').click();
    const row = $('dialog[aria-label="Edit name"]');
    await row.$('textarea').setValue('Unapplied sidebar row');
    await row.$('button=Keep edit').click();
    await browser.execute(() => {
      window.__sidebarDatabaseHost = document.getElementById('sidebar-panel-database');
    });
    await moveWithMenu('Database', 'left');
    assert.equal(await $('dialog[aria-label="Discard pending row edits?"]').isExisting(), false);
    assert.equal(await host('database').getAttribute('data-sidebar-side'), 'left');
    assert.match(await $('.sql-browser .data-grid').getText(), /Unapplied sidebar row/);
    assert.equal(
      await browser.execute(
        () => window.__sidebarDatabaseHost === document.getElementById('sidebar-panel-database'),
      ),
      true,
    );
    await tab('left', 'git').click();
    let discard = $('dialog[aria-label="Discard pending row edits?"]');
    await discard.waitForDisplayed();
    await discard.$('button=Keep editing').click();
    assert.match(await $('.sql-browser .data-grid').getText(), /Unapplied sidebar row/);
    await screenshot('database-moved');
    await tab('left', 'git').click();
    discard = $('dialog[aria-label="Discard pending row edits?"]');
    await discard.waitForDisplayed();
    await discard.$('button=Discard and close').click();
    await browser.waitUntil(async () => !(await $('.database-panel').isExisting()));
    const db = new DatabaseSync(databasePath);
    assert.equal(db.prepare('SELECT name FROM people WHERE id=1').get().name, 'Original row');
    db.close();
    await tab('right', 'http').click();
    await $('[aria-label="HTTP request source"]').waitForDisplayed();
    await $('[aria-label="HTTP request source"]').setValue(
      'GET https://example.invalid/sidebar-fixture\nX-Fixture: preserved',
    );
    await moveWithMenu('HTTP', 'left');
    assert.equal(await host('http').getAttribute('data-sidebar-side'), 'left');
    assert.equal(
      await $('[aria-label="HTTP request source"]').getValue(),
      'GET https://example.invalid/sidebar-fixture\nX-Fixture: preserved',
    );
    await screenshot('http-moved');
  });
});
