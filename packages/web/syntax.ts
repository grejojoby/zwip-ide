import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
export function createSyntax(extension: string) {
  if (extension === 'css') return css();
  if (extension === 'html' || extension === 'htm') return html();
  return javascript({
    typescript: ['ts', 'tsx', 'mts', 'cts'].includes(extension),
    jsx: ['jsx', 'tsx'].includes(extension),
  });
}
