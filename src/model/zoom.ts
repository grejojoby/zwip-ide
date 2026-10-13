import { getCurrentWebview } from '@tauri-apps/api/webview';
import { api } from '../api';

/** Whole-IDE zoom (⌘+ / ⌘− / ⌘0): native webview zoom scales text, icons and layout together. */
export const UI_ZOOM = { min: 0.5, max: 3, step: 0.1, initial: 1 };
/** Code font size (⌘/Ctrl + scroll or trackpad pinch over the editor), in CSS pixels. */
export const EDITOR_FONT = { min: 8, max: 40, initial: 12 };

export type ZoomDirection = 'in' | 'out' | 'reset';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const tauri = () => '__TAURI_INTERNALS__' in window;

export function zoomDirection(event: KeyboardEvent): ZoomDirection | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
  if (event.key === '=' || event.key === '+' || event.code === 'NumpadAdd') return 'in';
  if (event.key === '-' || event.key === '_' || event.code === 'NumpadSubtract') return 'out';
  if (event.key === '0' || event.code === 'Numpad0') return 'reset';
  return null;
}

export function nextUiZoom(current: number, direction: ZoomDirection): number {
  if (direction === 'reset') return UI_ZOOM.initial;
  const next = current + (direction === 'in' ? UI_ZOOM.step : -UI_ZOOM.step);
  return Math.round(clamp(next, UI_ZOOM.min, UI_ZOOM.max) * 10) / 10;
}

/** A mouse-wheel notch (~100px) changes the size by ~10%; pinch deltas are small and smooth. */
export function editorFontSizeAfterWheel(size: number, deltaY: number): number {
  const delta = clamp(deltaY, -10, 10);
  return (
    Math.round(clamp(size * Math.exp(-delta / 100), EDITOR_FONT.min, EDITOR_FONT.max) * 10) / 10
  );
}

let editorFontSize = EDITOR_FONT.initial;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

export function currentEditorFontSize() {
  return editorFontSize;
}

export function setEditorFontSize(size: number, persist = true) {
  editorFontSize = clamp(size, EDITOR_FONT.min, EDITOR_FONT.max);
  document.documentElement.style.setProperty('--editor-font-size', `${editorFontSize}px`);
  if (!persist || !tauri()) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(
    () => void api.setSetting('zwip.editorFontSize', editorFontSize).catch(() => undefined),
    250,
  );
}

export async function setUiZoom(zoom: number, persist = true) {
  if (!tauri()) return;
  await getCurrentWebview().setZoom(zoom);
  if (persist) await api.setSetting('zwip.uiZoom', zoom);
}
