// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { NavigationBatch, SourceLocation } from '../contracts';
import { shortDirectory, UsagesPopup } from './UsagesPopup';

vi.mock('../api', () => ({ request: async () => null }));
// jsdom has no text layout; CodeMirror measures ranges when scrolling the preview.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
afterEach(cleanup);

const usage = (path: string, line: number, preview: string): SourceLocation => ({
  path,
  range: { start: { line, character: 4 }, end: { line, character: 7 } },
  name: 'Run',
  preview,
  contextIds: ['ctx'],
  relationship: 'reference',
});
const batch = (state: NavigationBatch['state']): NavigationBatch => ({
  id: 'q',
  documentRevision: 1,
  workspaceGeneration: 1,
  state,
  locations: [usage('pkg/a.go', 9, '    s.Run()'), usage('pkg/b.go', 2, 'go Run()')],
  searchedContexts: 1,
  totalContexts: 2,
  reasons: [],
});

// pkg/a.go: the usage is on line 10 (index 9); lines 5–15 surround it.
const fileText = Array.from({ length: 20 }, (_, at) =>
  at === 9 ? '    Run()' : `line ${at + 1}`,
).join('\n');
function show(state: NavigationBatch['state'] = 'complete') {
  const handlers = {
    onOpen: vi.fn(),
    onDock: vi.fn(),
    onClose: vi.fn(),
    onNavigate: vi.fn(),
    loadPreview: vi.fn(async () => fileText),
  };
  render(
    <UsagesPopup
      anchor={{ left: 40, top: 100, bottom: 118 }}
      symbol="Run"
      batch={batch(state)}
      loading={false}
      dark
      {...handlers}
    />,
  );
  return handlers;
}

describe('usages popup', () => {
  it('sits below the caret line and lists usages with syntax-colored code', async () => {
    show();
    const popup = screen.getByRole('dialog', { name: 'Usages of Run' });
    expect(popup.style.top).toBe('124px');
    expect(screen.getByText('a.go:10')).toBeTruthy();
    expect(screen.getByText('2 usages', { exact: false })).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText('Run')[1].className).toBe('tok-function-call'));
  });
  it('opens the highlighted usage with the keyboard and closes on Escape', () => {
    const { onOpen, onClose } = show();
    const list = screen.getByRole('listbox', { name: 'Usages' });
    expect(document.activeElement).toBe(list);
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onOpen.mock.calls[0][0].path).toBe('pkg/b.go');
    fireEvent.keyDown(list, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
  it('docks to the bottom panel and reports incomplete coverage', () => {
    const { onDock } = show('partial');
    expect(screen.getByText('partial')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dock to bottom panel' }));
    expect(onDock).toHaveBeenCalled();
  });
  it('shows a trimmed workspace-relative folder before each file name', () => {
    show();
    expect(screen.getAllByTitle('pkg/a.go')[0].textContent).toBe('pkg/a.go:10');
  });
  it.each([
    ['/w/main.go', ''],
    ['/w/cmd/main.go', 'cmd'],
    ['/w/cmd/api/main.go', 'cmd/api'],
    ['/w/services/billing/internal/http/handler.go', 'services/…/http'],
  ])('shortens %s to %j', (path, expected) => {
    expect(shortDirectory(path, '/w')).toBe(expected);
  });
  it('previews the selected usage with its surrounding lines and highlights the match', async () => {
    const { loadPreview } = show();
    const preview = await screen.findByLabelText('Preview of pkg/a.go');
    await waitFor(() => expect(preview.textContent).toContain('Run()'));
    expect(loadPreview).toHaveBeenCalledWith('pkg/a.go');
    expect(preview.textContent).toContain('line 5');
    expect(preview.textContent).toContain('line 15');
    expect(preview.querySelector('.usage-preview-match')?.textContent).toBe('Run');
    expect(preview.querySelector('.usage-preview-line')?.textContent).toContain('Run()');
    fireEvent.keyDown(screen.getByRole('listbox', { name: 'Usages' }), { key: 'ArrowDown' });
    expect(await screen.findByLabelText('Preview of pkg/b.go')).toBeTruthy();
  });
  it('navigates from a ⌘-click in the preview without opening the usage itself', async () => {
    const { onNavigate, onOpen } = show();
    const preview = await screen.findByLabelText('Preview of pkg/a.go');
    await waitFor(() => expect(preview.querySelector('.cm-content')).toBeTruthy());
    // jsdom has no layout; map the click to the "Run" call on line 10.
    const offset = fileText.indexOf('Run');
    vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue(offset + 1);
    fireEvent.mouseDown(preview.querySelector('.cm-content')!, { metaKey: true, button: 0 });
    expect(onNavigate).toHaveBeenCalledWith('pkg/a.go', { line: 9, character: 5 });
    fireEvent.mouseDown(preview.querySelector('.cm-content')!, { button: 0 });
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
