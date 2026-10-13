// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EDITOR_FONT, UI_ZOOM, editorFontSizeAfterWheel, nextUiZoom, zoomDirection } from './zoom';

const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

describe('zoom', () => {
  it('maps ⌘+, ⌘=, ⌘− and ⌘0 to IDE zoom directions', () => {
    expect(zoomDirection(key({ key: '=', metaKey: true }))).toBe('in');
    expect(zoomDirection(key({ key: '+', metaKey: true, shiftKey: true }))).toBe('in');
    expect(zoomDirection(key({ key: '-', ctrlKey: true }))).toBe('out');
    expect(zoomDirection(key({ key: '0', metaKey: true }))).toBe('reset');
    expect(zoomDirection(key({ key: '=' }))).toBeNull();
    expect(zoomDirection(key({ key: 'a', metaKey: true }))).toBeNull();
  });

  it('steps and clamps the IDE zoom', () => {
    expect(nextUiZoom(1, 'in')).toBe(1.1);
    expect(nextUiZoom(1.1, 'out')).toBe(1);
    expect(nextUiZoom(UI_ZOOM.max, 'in')).toBe(UI_ZOOM.max);
    expect(nextUiZoom(UI_ZOOM.min, 'out')).toBe(UI_ZOOM.min);
    expect(nextUiZoom(2.4, 'reset')).toBe(UI_ZOOM.initial);
  });

  it('grows the code font on pinch-out / scroll-up and clamps it', () => {
    expect(editorFontSizeAfterWheel(12, -100)).toBeGreaterThan(12);
    expect(editorFontSizeAfterWheel(12, 100)).toBeLessThan(12);
    expect(editorFontSizeAfterWheel(12, -100)).toBeLessThan(14);
    expect(editorFontSizeAfterWheel(EDITOR_FONT.max, -100)).toBe(EDITOR_FONT.max);
    expect(editorFontSizeAfterWheel(EDITOR_FONT.min, 100)).toBe(EDITOR_FONT.min);
  });
});
