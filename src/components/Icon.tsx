import type { CSSProperties } from 'react';
export type IconName =
  | 'folder'
  | 'file'
  | 'chevron'
  | 'search'
  | 'branch'
  | 'play'
  | 'stop'
  | 'close'
  | 'split'
  | 'package'
  | 'sun'
  | 'moon'
  | 'back'
  | 'forward'
  | 'refresh'
  | 'terminal'
  | 'save'
  | 'git'
  | 'eye'
  | 'arrow'
  | 'clock'
  | 'database'
  | 'http';
const paths: Record<IconName, string> = {
  database: 'M3 5c0-4 18-4 18 0s-18 4-18 0ZM3 5v14c0 4 18 4 18 0V5M3 12c0 4 18 4 18 0',
  http: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM2 12h20M12 2c-6 5-6 15 0 20M12 2c6 5 6 15 0 20',
  folder: 'M2 5h5l2 2h13v12H2z',
  file: 'M6 2h8l4 4v16H6z M14 2v5h4',
  chevron: 'm9 5 7 7-7 7',
  search: 'M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15ZM16 16l6 6',
  branch:
    'M6 8v8M18 8v3c0 5-12 0-12 5M6 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  play: 'm7 3 14 9-14 9z',
  stop: 'M5 5h14v14H5z',
  close: 'm6 6 12 12M6 18 18 6',
  split: 'M3 3h18v18H3zM12 3v18',
  package: 'm12 2 10 5v10l-10 5-10-5V7zM2 7l10 5 10-5M12 12v10M7 4.5l10 5V15',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 1v3M12 20v3M1 12h3M20 12h3M4 4l2 2M18 18l2 2M4 20l2-2M18 6l2-2',
  moon: 'M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z',
  back: 'm14 5-7 7 7 7',
  forward: 'm10 5 7 7-7 7',
  refresh: 'M20 7A9 9 0 1 0 21 14M20 2v6h-6',
  terminal: 'm4 6 6 6-6 6M13 18h7',
  save: 'M3 3h15l3 3v15H3zM7 3v7h10V3M7 21v-7h10v7',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
  git: 'm12 2 10 10-10 10L2 12zM8 6l8 10M12 10v7',
  arrow: 'M12 20V4m-7 7 7-7 7 7',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 6v6l4 3',
};
export function Icon({ name, style }: { name: IconName; style?: CSSProperties }) {
  return (
    <svg
      className="icon"
      style={style}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
