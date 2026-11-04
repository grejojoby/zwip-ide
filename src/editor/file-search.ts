import { EditorView, runScopeHandlers, type Panel, type ViewUpdate } from '@codemirror/view';
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  search,
  SearchQuery,
  setSearchQuery,
} from '@codemirror/search';

let panelId = 0;
const matchLimit = 10_000;

class FileSearchPanel implements Panel {
  readonly dom = document.createElement('div');
  readonly top = true;
  private input = document.createElement('input');
  private count = document.createElement('span');
  private query: SearchQuery;
  private matches: { from: number; to: number }[] = [];
  private truncated = false;
  private toggles: {
    button: HTMLButtonElement;
    option: 'caseSensitive' | 'wholeWord' | 'regexp';
  }[];
  private previous: HTMLButtonElement;
  private next: HTMLButtonElement;

  constructor(private view: EditorView) {
    this.query = getSearchQuery(view.state);
    this.dom.className = 'cm-file-search';
    this.dom.setAttribute('role', 'search');
    this.dom.setAttribute('aria-label', 'Find in file');
    this.input.type = 'search';
    this.input.placeholder = 'Find in file…';
    this.input.setAttribute('aria-label', 'Find in file');
    this.input.setAttribute('main-field', 'true');
    this.input.setAttribute('spellcheck', 'false');
    this.input.autocomplete = 'off';
    this.input.addEventListener('input', () => this.commit());
    this.count.id = `file-search-count-${++panelId}`;
    this.count.className = 'cm-file-search-count';
    this.count.setAttribute('role', 'status');
    this.count.setAttribute('aria-live', 'polite');
    this.count.setAttribute('aria-atomic', 'true');
    this.input.setAttribute('aria-describedby', this.count.id);
    this.toggles = (
      [
        { option: 'caseSensitive', label: 'Match case', text: 'Aa' },
        { option: 'wholeWord', label: 'Whole word', text: 'Ab' },
        { option: 'regexp', label: 'Regular expression', text: '.*' },
      ] as const
    ).map(({ option, label, text }) => ({
      option,
      button: this.button(label, text, () => this.commit({ [option]: !this.query[option] })),
    }));
    this.previous = this.button('Previous match', '↑', () => this.move(true));
    this.next = this.button('Next match', '↓', () => this.move(false));
    this.dom.append(
      this.input,
      ...this.toggles.map(({ button }) => button),
      this.count,
      this.previous,
      this.next,
      this.button('Close find', '×', () => closeSearchPanel(this.view)),
    );
    this.dom.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (runScopeHandlers(this.view, event, 'search-panel')) event.preventDefault();
      else if (event.key === 'Enter' && event.target === this.input) {
        event.preventDefault();
        this.move(event.shiftKey);
      }
    });
    this.refresh(true);
  }

  private button(label: string, text: string, run: () => void) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', run);
    return button;
  }

  private commit(
    options: Partial<Pick<SearchQuery, 'caseSensitive' | 'wholeWord' | 'regexp'>> = {},
  ) {
    const query = new SearchQuery({
      ...this.query,
      ...options,
      search: this.input.value,
      literal: true,
    });
    const start = this.view.state.selection.main.from;
    this.view.dispatch({ effects: setSearchQuery.of(query) });
    if (query.valid) {
      let cursor = query.getCursor(this.view.state, start).next();
      if (cursor.done) cursor = query.getCursor(this.view.state).next();
      if (!cursor.done) {
        const { from, to } = cursor.value;
        this.view.dispatch({
          selection: { anchor: from, head: to },
          effects: EditorView.scrollIntoView(from, { y: 'center' }),
          userEvent: 'select.search.input',
        });
      }
    }
    this.input.focus();
  }

  private move(previous: boolean) {
    if (!this.query.valid || !this.matches.length) return;
    (previous ? findPrevious : findNext)(this.view);
    this.input.focus();
  }

  private refresh(recount: boolean) {
    this.query = getSearchQuery(this.view.state);
    if (this.input.value !== this.query.search) this.input.value = this.query.search;
    for (const { button, option } of this.toggles)
      button.setAttribute('aria-pressed', String(this.query[option]));
    const invalid = !!this.query.search && !this.query.valid;
    this.input.setAttribute('aria-invalid', String(invalid));
    if (recount) {
      this.matches = [];
      this.truncated = false;
      if (this.query.valid) {
        const cursor = this.query.getCursor(this.view.state);
        for (let match = cursor.next(); !match.done; match = cursor.next()) {
          if (this.matches.length === matchLimit) {
            this.truncated = true;
            break;
          }
          this.matches.push(match.value);
        }
      }
    }
    const { from, to } = this.view.state.selection.main;
    const index = this.matches.findIndex((match) => match.from === from && match.to === to);
    const total = `${this.matches.length.toLocaleString()}${this.truncated ? '+' : ''}`;
    this.count.textContent = !this.query.search
      ? 'Type to find'
      : invalid
        ? 'Invalid regular expression'
        : !this.matches.length
          ? 'No results'
          : index >= 0
            ? `${index + 1} of ${total}`
            : `${total} matches`;
    this.previous.disabled = this.next.disabled = !this.query.valid || !this.matches.length;
  }

  update(update: ViewUpdate) {
    const changed = !getSearchQuery(update.state).eq(this.query);
    if (changed || update.docChanged || update.selectionSet)
      this.refresh(changed || update.docChanged);
  }

  mount() {
    this.input.focus();
    this.input.select();
  }
}

// Keep search state installed across tab remounts instead of relying on the lazy default panel.
export const fileSearch = search({
  top: true,
  literal: true,
  createPanel: (view) => new FileSearchPanel(view),
});
