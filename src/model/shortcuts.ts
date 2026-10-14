export const shortcutActions = {
  save: 'Save file',
  files: 'Go to file',
  symbols: 'Go to symbol',
  actions: 'Find action',
  search: 'Find text in workspace',
  back: 'Navigate back',
  forward: 'Navigate forward',
  declaration: 'Declaration / usages',
  implementations: 'Implementations',
  usages: 'Find usages',
  format: 'Format file',
  rename: 'Rename symbol',
  fixes: 'Quick fixes',
  copyReference: 'Copy reference (path:line)',
  breakpoint: 'Toggle breakpoint',
  branches: 'Git branches',
} as const;
export type ShortcutAction = keyof typeof shortcutActions;
export type Shortcuts = Record<ShortcutAction, string>;
export const defaultShortcuts: Shortcuts = {
  save: 'Mod-s',
  files: 'Mod-Shift-o',
  symbols: 'Mod-Alt-o',
  actions: 'Mod-Shift-a',
  search: 'Mod-Shift-f',
  back: 'Mod-[',
  forward: 'Mod-]',
  declaration: 'Mod-b',
  implementations: 'Mod-Alt-b',
  usages: 'Alt-F7',
  format: 'Mod-Alt-l',
  rename: 'Shift-F6',
  fixes: 'Alt-Enter',
  copyReference: 'Mod-Alt-Shift-c',
  breakpoint: 'Mod-F8',
  branches: 'Mod-Shift-b',
};
const modifierOrder = ['Mod', 'Ctrl', 'Alt', 'Shift'];
const namedKeys = [
  'Enter',
  'Escape',
  'Tab',
  'Space',
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
];

/** Single-stroke syntax shared with CodeMirror; Mod and Meta both mean Command on macOS. */
export function canonicalShortcut(value: string): string | null {
  if (value === '') return '';
  // A final hyphen is the literal key, as in CodeMirror's "Mod--".
  const parts = value.split(/-(?!$)/);
  const rawKey = parts.pop() ?? '';
  const key = rawKey === ' ' ? 'Space' : rawKey.trim();
  const modifiers = parts.map((part) => {
    const name = part.trim().toLowerCase();
    return name === 'meta' ? 'Mod' : modifierOrder.find((item) => item.toLowerCase() === name);
  });
  if (modifiers.some((part) => !part) || new Set(modifiers).size !== modifiers.length) return null;
  const functionKey = /^F(?:[1-9]|1\d|2[0-4])$/i.test(key);
  if (!modifiers.length && !functionKey) return null;
  const canonicalKey = functionKey
    ? key.toUpperCase()
    : (namedKeys.find((name) => name.toLowerCase() === key.toLowerCase()) ??
      (key.length === 1 && !/\s/.test(key) ? key.toLowerCase() : null));
  if (!canonicalKey) return null;
  return [...modifierOrder.filter((part) => modifiers.includes(part)), canonicalKey].join('-');
}
export function validShortcut(value: string): boolean {
  return canonicalShortcut(value) !== null;
}
export function normalizedShortcuts(value: Partial<Shortcuts> | null | undefined): Shortcuts {
  return Object.fromEntries(
    Object.entries(defaultShortcuts).map(([key, fallback]) => [
      key,
      typeof value?.[key as ShortcutAction] === 'string'
        ? (canonicalShortcut(value[key as ShortcutAction]!) ?? fallback)
        : fallback,
    ]),
  ) as Shortcuts;
}
export function shortcutLabel(value: string): string {
  return (canonicalShortcut(value) ?? value)
    .replace('Mod-', '⌘')
    .replace('Ctrl-', '⌃')
    .replace('Alt-', '⌥')
    .replace('Shift-', '⇧')
    .replace('Meta-', '⌘')
    .replace(/(^|[⌘⌃⌥⇧])([a-z])/g, (_, prefix: string, key: string) => prefix + key.toUpperCase());
}
export function shortcutFromEvent(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
): string | null {
  if (['Meta', 'Control', 'Alt', 'Shift', 'Dead', 'Unidentified'].includes(event.key)) return null;
  let key = /^Key[A-Z]$/.test(event.code)
    ? event.code.slice(3).toLowerCase()
    : /^Digit\d$/.test(event.code)
      ? event.code.slice(5)
      : (punctuationCodes[event.code] ?? event.key);
  if (key === ' ') key = 'Space';
  return `${event.metaKey ? 'Mod-' : ''}${event.ctrlKey ? 'Ctrl-' : ''}${event.altKey ? 'Alt-' : ''}${event.shiftKey ? 'Shift-' : ''}${key}`;
}
export function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const recorded = shortcutFromEvent(event);
  const canonical = canonicalShortcut(shortcut);
  return !!canonical && recorded !== null && canonicalShortcut(recorded) === canonical;
}
export function shortcutConflicts(shortcuts: Shortcuts): string[] {
  const keys = new Map<string, string>();
  const conflicts: string[] = [];
  for (const [action, shortcut] of Object.entries(shortcuts)) {
    if (!shortcut) continue;
    const canonical = canonicalShortcut(shortcut);
    if (!canonical) continue;
    const previous = keys.get(canonical);
    if (previous)
      conflicts.push(
        `${previous} and ${shortcutActions[action as ShortcutAction]} both use ${shortcutLabel(shortcut)}.`,
      );
    else keys.set(canonical, shortcutActions[action as ShortcutAction]);
  }
  return conflicts;
}

const punctuationCodes: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Minus: '-',
  Equal: '=',
};
