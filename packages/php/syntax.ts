import { StreamLanguage, type StreamParser } from '@codemirror/language';

const keywords = new Set(
  'abstract and array as break callable case catch class clone const continue declare default die do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum eval exit extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield true false null self parent int float string bool void mixed never object'.split(
    ' ',
  ),
);
interface State {
  php: boolean;
  comment: boolean;
  quote: string | null;
  heredoc: string | null;
}
/** PHP islands in HTML, comments, quoted strings and heredoc/nowdoc bodies. */
const grammar: StreamParser<State> = {
  name: 'php',
  startState: () => ({ php: false, comment: false, quote: null, heredoc: null }),
  token(stream, state) {
    if (state.heredoc) {
      if (stream.sol() && stream.match(new RegExp('^[ \\t]*' + state.heredoc + '(?=[;,)]|$)')))
        state.heredoc = null;
      else stream.skipToEnd();
      return 'string';
    }
    if (state.comment) {
      while (!stream.eol()) {
        if (stream.match('*/')) {
          state.comment = false;
          break;
        }
        stream.next();
      }
      return 'comment';
    }
    if (state.quote) {
      while (!stream.eol()) {
        const c = stream.next();
        if (c === '\\') stream.next();
        else if (c === state.quote) {
          state.quote = null;
          break;
        }
      }
      return 'string';
    }
    if (!state.php) {
      if (stream.match(/^<\?(?:php\b|=)/i)) {
        state.php = true;
        return 'meta';
      }
      stream.next();
      while (!stream.eol() && !stream.match(/^<\?(?:php\b|=)/i, false)) stream.next();
      return null;
    }
    if (stream.eatSpace()) return null;
    if (stream.match('?>')) {
      state.php = false;
      return 'meta';
    }
    if (stream.match('/*')) {
      state.comment = true;
      return 'comment';
    }
    if (stream.match('//') || stream.match(/#(?!\[)/)) {
      stream.skipToEnd();
      return 'comment';
    }
    const heredoc = stream.match(
      /^<<<[ \t]*['"]?([A-Za-z_][A-Za-z_0-9]*)['"]?/,
    ) as RegExpMatchArray | null;
    if (heredoc) {
      state.heredoc = heredoc[1];
      return 'string';
    }
    if (stream.match(/['"`]/)) {
      state.quote = stream.current();
      return 'string';
    }
    if (stream.match(/^\$[\w\u0080-\uffff]+/)) return 'variableName';
    if (
      stream.match(
        /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?)/,
      )
    )
      return 'number';
    if (stream.match(/^[a-zA-Z_\u0080-\uffff][\w\u0080-\uffff]*/))
      return keywords.has(stream.current().toLowerCase()) ? 'keyword' : 'variableName';
    if (stream.match(/^[+*/%=!<>?:&|~^.-]+/)) return 'operator';
    stream.next();
    return 'punctuation';
  },
  languageData: {
    commentTokens: { line: '//', block: { open: '/*', close: '*/' } },
    closeBrackets: { brackets: ['(', '[', '{', "'", '"'] },
  },
};
export function createSyntax() {
  return StreamLanguage.define(grammar);
}
