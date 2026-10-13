import { StreamLanguage, type StreamParser } from '@codemirror/language';

const directives = new Set([
  'include',
  '-include',
  'sinclude',
  'ifeq',
  'ifneq',
  'ifdef',
  'ifndef',
  'else',
  'endif',
  'define',
  'endef',
  'export',
  'unexport',
  'override',
  'private',
  'vpath',
]);

interface State {
  /** Inside a tab-indented recipe line, which is shell text. */
  recipe: boolean;
  /** Nesting depth of $( … ) / ${ … } references. */
  depth: number;
  quote: string | null;
}

/** GNU Make: comments, directives, rule targets, assignments, variable references and recipes. */
const makefile: StreamParser<State> = {
  name: 'makefile',
  startState: () => ({ recipe: false, depth: 0, quote: null }),
  token(stream, state) {
    if (stream.sol()) {
      state.recipe = stream.peek() === '\t';
      state.quote = null;
    }
    if (state.depth > 0) {
      if (stream.match(/^[)}]/)) state.depth--;
      else if (stream.match(/^\$[({]/)) state.depth++;
      else if (!stream.match(/^[^$)}]+/)) stream.next();
      return 'variableName';
    }
    if (stream.match(/^\$[({]/)) {
      state.depth = 1;
      return 'variableName';
    }
    if (stream.match(/^\$[@<^+?*%$]|^\$[A-Za-z]/)) return 'variableName';
    if (state.quote) {
      while (!stream.eol()) {
        const next = stream.next();
        if (next === '\\') stream.next();
        else if (next === state.quote) {
          state.quote = null;
          break;
        } else if (stream.peek() === '$') break;
      }
      return 'string';
    }
    if (stream.eatSpace()) return null;
    if (stream.peek() === '#') {
      stream.skipToEnd();
      return 'comment';
    }
    if (state.recipe) {
      if (stream.match(/^["']/)) {
        state.quote = stream.current();
        return 'string';
      }
      if (stream.sol() || stream.column() === 0) stream.match(/^[@+-]+/);
      if (!stream.match(/^[^\s$"'#]+/)) stream.next();
      return null;
    }
    if (stream.sol()) {
      const word = stream.match(/^-?[A-Za-z_][\w-]*/, false) as RegExpMatchArray | null;
      if (word && directives.has(word[0])) {
        stream.match(word[0]);
        return 'keyword';
      }
      if (stream.match(/^\.[A-Z_]+(?=\s*:)/)) return 'keyword';
      // A rule's targets: everything before a single ':' that is not an assignment.
      if (stream.match(/^[^:#=\s$]+(?:\s+[^:#=\s$]+)*(?=\s*::?(?!=))/)) return 'def';
    }
    if (stream.match(/^(?:::=|:=|\?=|\+=|!=|=)/)) return 'operator';
    if (stream.match(/^::?/)) return 'punctuation';
    if (!stream.match(/^[^\s$#:=?+!]+/)) stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '#' } },
};

export function createSyntax() {
  return StreamLanguage.define(makefile);
}
