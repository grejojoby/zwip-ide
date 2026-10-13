import { describe, expect, it } from 'vitest';
import {
  closeSidebar,
  defaultSidebarLayout,
  moveSidebarTool,
  openSidebarTool,
  readSidebarLayout,
  sidebarLabels,
  sidebarTools,
  toggleSidebarTool,
  type SidebarLayout,
  type SidebarSide,
} from './sidebar-layout';

function expectValid(layout: SidebarLayout) {
  expect(layout.version).toBe(1);
  expect(Object.keys(layout.placements).sort()).toEqual([...sidebarTools].sort());
  for (const side of ['left', 'right'] as const) {
    const active = layout.active[side];
    if (active !== null) expect(layout.placements[active]).toBe(side);
  }
  expect(
    sidebarTools.filter((tool) => layout.placements[tool] === 'left').length +
      sidebarTools.filter((tool) => layout.placements[tool] === 'right').length,
  ).toBe(4);
}

describe('sidebar layout', () => {
  it('provides fresh defaults with Project open on the left and other tools closed on the right', () => {
    const first = defaultSidebarLayout();
    expect(first).toEqual({
      version: 1,
      placements: { project: 'left', git: 'right', database: 'right', http: 'right' },
      active: { left: 'project', right: null },
    });
    expect(sidebarTools).toEqual(['project', 'git', 'database', 'http']);
    expect(sidebarLabels).toEqual({
      project: 'Project',
      git: 'Git',
      database: 'Database',
      http: 'HTTP',
    });
    first.placements.git = 'left';
    first.active.left = null;
    expect(defaultSidebarLayout()).not.toEqual(first);
  });

  it('moves Git to the left and switches it with Project without duplicating or mutating tools', () => {
    const original = defaultSidebarLayout();
    const moved = moveSidebarTool(original, 'git', 'left');
    expect(moved.placements.git).toBe('left');
    expect(moved.active).toEqual({ left: 'git', right: null });
    expect(original).toEqual(defaultSidebarLayout());
    const project = openSidebarTool(moved, 'project');
    expect(project.active.left).toBe('project');
    expect(project.placements).toEqual(moved.placements);
    const git = toggleSidebarTool(project, 'git');
    expect(git.active.left).toBe('git');
    expect(toggleSidebarTool(git, 'git').active.left).toBeNull();
    expectValid(git);
  });

  it('activates the destination and restores Project when the active tool leaves its side', () => {
    const leftGit = moveSidebarTool(defaultSidebarLayout(), 'git', 'left');
    const moved = moveSidebarTool(openSidebarTool(leftGit, 'database'), 'git', 'right');
    expect(moved.active).toEqual({ left: 'project', right: 'git' });
    expect(moved.placements.database).toBe('right');
    const projectRight = moveSidebarTool(moved, 'project', 'right');
    expect(projectRight.active).toEqual({ left: null, right: 'project' });
    expectValid(projectRight);
  });

  it('keeps an active source tool when another tool moves and does not reopen same-side moves', () => {
    const state = openSidebarTool(defaultSidebarLayout(), 'http');
    const moved = moveSidebarTool(state, 'git', 'left');
    expect(moved.active).toEqual({ left: 'git', right: 'http' });
    const closed = closeSidebar(moved, 'left');
    expect(moveSidebarTool(closed, 'git', 'left')).toBe(closed);
    expect(closeSidebar(closed, 'left')).toBe(closed);
    expect(openSidebarTool(state, 'http')).toBe(state);
  });

  it('round-trips independent side selections and explicit closed panels through persisted JSON', () => {
    const configured = closeSidebar(
      moveSidebarTool(defaultSidebarLayout(), 'database', 'left'),
      'right',
    );
    expect(readSidebarLayout(JSON.parse(JSON.stringify(configured)), 'http')).toEqual(configured);
    const allClosed = closeSidebar(configured, 'left');
    expect(readSidebarLayout(allClosed, 'git')).toEqual(allClosed);
    const read = readSidebarLayout(configured);
    read.placements.project = 'right';
    expect(configured.placements.project).toBe('left');
  });

  it('migrates only legacy auxiliary tools when a version 1 layout is unavailable', () => {
    for (const legacy of ['git', 'database', 'http'] as const) {
      expect(readSidebarLayout(undefined, legacy).active).toEqual({
        left: 'project',
        right: legacy,
      });
      expect(readSidebarLayout({ version: 2 }, legacy).active.right).toBe(legacy);
    }
    for (const legacy of ['project', '__proto__', 'terminal', {}, null]) {
      expect(readSidebarLayout(null, legacy)).toEqual(defaultSidebarLayout());
    }
    expect(readSidebarLayout({ version: 1 }, 'git')).toEqual(defaultSidebarLayout());
  });

  it('normalizes malformed placements and active selections without importing unknown keys', () => {
    const layout = readSidebarLayout({
      version: 1,
      placements: { project: 'right', git: 'left', database: 'bottom', unknown: 'left' },
      active: { left: 'http', right: 'missing', bottom: 'database' },
    });
    expect(layout).toEqual({
      version: 1,
      placements: { project: 'right', git: 'left', database: 'right', http: 'right' },
      active: { left: null, right: 'project' },
    });
    expectValid(layout);
    for (const invalid of [
      undefined,
      null,
      1,
      'layout',
      [],
      { version: '1' },
      { version: 1, placements: [], active: 42 },
    ])
      expect(readSidebarLayout(invalid)).toEqual(defaultSidebarLayout());
  });

  it('ignores inherited fields, prototype-like tool names and accessor properties', () => {
    let getterCalled = false;
    const placements = Object.create({ project: 'right', git: 'left' }) as Record<string, unknown>;
    Object.defineProperty(placements, 'http', {
      get() {
        getterCalled = true;
        return 'left';
      },
    });
    const active = JSON.parse(
      '{"left":"constructor","right":"__proto__","__proto__":{"polluted":true}}',
    );
    const result = readSidebarLayout({ version: 1, placements, active });
    expect(result).toEqual(defaultSidebarLayout());
    expect(getterCalled).toBe(false);
    expect(readSidebarLayout(Object.create({ version: 1, placements }), 'git').active.right).toBe(
      'git',
    );
    expectValid(result);
  });

  it('maintains placement and active invariants across moves, opening, toggling and closure', () => {
    let state = defaultSidebarLayout();
    for (const tool of sidebarTools) {
      for (const side of ['left', 'right'] as SidebarSide[]) {
        state = moveSidebarTool(state, tool, side);
        expectValid(state);
        state = toggleSidebarTool(state, tool);
        expectValid(state);
        state = openSidebarTool(state, tool);
        expectValid(state);
        state = readSidebarLayout(JSON.parse(JSON.stringify(state)));
        expectValid(state);
        state = closeSidebar(state, side);
        expectValid(state);
      }
    }
  });
});
