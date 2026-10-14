/** File types offered by New Scratch File, with IntelliJ-like starter content. */
export interface ScratchType {
  label: string;
  extension: string;
  template: string;
}
export const scratchTypes: readonly ScratchType[] = [
  { label: 'Go', extension: 'go', template: 'package main\n\nfunc main() {\n\t\n}\n' },
  { label: 'JSON', extension: 'json', template: '{\n  \n}\n' },
  { label: 'Markdown', extension: 'md', template: '# \n' },
  { label: 'Plain text', extension: 'txt', template: '' },
  { label: 'SQL', extension: 'sql', template: 'SELECT 1;\n' },
  { label: 'YAML', extension: 'yaml', template: '' },
  {
    label: 'Shell script',
    extension: 'sh',
    template: '#!/usr/bin/env bash\nset -euo pipefail\n\n',
  },
  { label: 'TypeScript', extension: 'ts', template: '' },
  { label: 'JavaScript', extension: 'js', template: '' },
  { label: 'Python', extension: 'py', template: '' },
  {
    label: 'HTML',
    extension: 'html',
    template: '<!doctype html>\n<html>\n  <body>\n    \n  </body>\n</html>\n',
  },
  { label: 'CSS', extension: 'css', template: '' },
  { label: 'XML', extension: 'xml', template: '<?xml version="1.0" encoding="UTF-8"?>\n' },
  { label: 'TOML', extension: 'toml', template: '' },
  {
    label: 'HTTP request',
    extension: 'http',
    template: 'GET https://example.com\nAccept: application/json\n',
  },
];
