import { describe, expect, it } from 'vitest';
import { isMarkdownPath, renderMarkdown } from './markdown';

describe('markdown preview rendering', () => {
  it('renders common markdown structure', () => {
    const html = renderMarkdown('# Title\n\n- one\n- **two**\n\n```go\nfmt.Println()\n```\n');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<li><strong>two</strong></li>');
    expect(html).toContain('<pre><code class="language-go">');
  });
  it('does not pass raw HTML or script URLs through', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n[x](javascript:alert(1))\n');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('href="javascript:');
  });
  it('marks links as non-opener', () => {
    expect(renderMarkdown('[site](https://example.com)')).toContain('rel="noopener noreferrer"');
  });
  it('recognizes markdown files by extension', () => {
    expect(isMarkdownPath('/p/README.MD')).toBe(true);
    expect(isMarkdownPath('/p/notes.markdown')).toBe(true);
    expect(isMarkdownPath('/p/main.go')).toBe(false);
  });
});
