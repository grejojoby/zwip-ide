import MarkdownIt from 'markdown-it';

// Raw HTML stays disabled so document text can never inject markup; markdown-it
// also rejects javascript:, vbscript: and most data: link targets.
const renderer = new MarkdownIt({ html: false, linkify: true, typographer: false });

const defaultLinkOpen =
  renderer.renderer.rules.link_open ??
  ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
renderer.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, index, options, env, self);
};

export const markdownExtensions = ['.md', '.markdown', '.mdown', '.mkd'];

export function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return markdownExtensions.some((extension) => lower.endsWith(extension));
}

export function renderMarkdown(source: string): string {
  return renderer.render(source);
}
