export const sidebarTools = ['project', 'git', 'database', 'http'] as const;
export type SidebarTool = (typeof sidebarTools)[number];
export type SidebarSide = 'left' | 'right';
export const sidebarLabels: Record<SidebarTool, string> = {
  project: 'Project',
  git: 'Git',
  database: 'Database',
  http: 'HTTP',
};
export interface SidebarLayout {
  version: 1;
  placements: Record<SidebarTool, SidebarSide>;
  active: Record<SidebarSide, SidebarTool | null>;
}

export function defaultSidebarLayout(): SidebarLayout {
  return {
    version: 1,
    placements: { project: 'left', git: 'right', database: 'right', http: 'right' },
    active: { left: 'project', right: null },
  };
}

/** Persisted input may be malformed; only known own data properties are considered. */
function own(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}
function isTool(value: unknown): value is SidebarTool {
  return typeof value === 'string' && sidebarTools.some((tool) => tool === value);
}
function fallback(layout: SidebarLayout, side: SidebarSide): SidebarTool | null {
  return layout.placements.project === side ? 'project' : null;
}

export function readSidebarLayout(value: unknown, legacyAuxiliary?: unknown): SidebarLayout {
  const layout = defaultSidebarLayout();
  if (own(value, 'version') !== 1) {
    if (legacyAuxiliary === 'git' || legacyAuxiliary === 'database' || legacyAuxiliary === 'http')
      layout.active.right = legacyAuxiliary;
    return layout;
  }
  const placements = own(value, 'placements');
  for (const tool of sidebarTools) {
    const side = own(placements, tool);
    if (side === 'left' || side === 'right') layout.placements[tool] = side;
  }
  const active = own(value, 'active');
  for (const side of ['left', 'right'] as const) {
    const tool = own(active, side);
    layout.active[side] =
      tool === null
        ? null
        : isTool(tool) && layout.placements[tool] === side
          ? tool
          : fallback(layout, side);
  }
  return layout;
}

export function moveSidebarTool(
  layout: SidebarLayout,
  tool: SidebarTool,
  side: SidebarSide,
): SidebarLayout {
  const source = layout.placements[tool];
  if (source === side) return layout;
  const moved: SidebarLayout = {
    ...layout,
    placements: { ...layout.placements, [tool]: side },
    active: { ...layout.active, [side]: tool },
  };
  if (layout.active[source] === tool) moved.active[source] = fallback(moved, source);
  return moved;
}

export function openSidebarTool(layout: SidebarLayout, tool: SidebarTool): SidebarLayout {
  const side = layout.placements[tool];
  return layout.active[side] === tool
    ? layout
    : { ...layout, active: { ...layout.active, [side]: tool } };
}

export function closeSidebar(layout: SidebarLayout, side: SidebarSide): SidebarLayout {
  return layout.active[side] === null
    ? layout
    : { ...layout, active: { ...layout.active, [side]: null } };
}

export function toggleSidebarTool(layout: SidebarLayout, tool: SidebarTool): SidebarLayout {
  const side = layout.placements[tool];
  return layout.active[side] === tool ? closeSidebar(layout, side) : openSidebarTool(layout, tool);
}
