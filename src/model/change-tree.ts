export type ChangeRow<T> =
  | { kind: 'directory'; path: string; label: string; depth: number; files: T[] }
  | { kind: 'file'; file: T; label: string; depth: number };

interface Directory<T> {
  directories: Map<string, Directory<T>>;
  files: T[];
}

// Code-point order keeps "x.go" before "x_test.go", as IntelliJ lists them.
const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * IntelliJ's Group By › Directory: only directories holding changes appear, and a directory
 * whose sole content is one subdirectory is merged with it ("app/pkg/fetcher").
 * Rows inside a collapsed directory are left out.
 */
export function changeTree<T extends { path: string }>(
  files: T[],
  collapsed: ReadonlySet<string> = new Set(),
): ChangeRow<T>[] {
  const root: Directory<T> = { directories: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.directories.get(part);
      if (!next) node.directories.set(part, (next = { directories: new Map(), files: [] }));
      node = next;
    }
    node.files.push(file);
  }
  const rows: ChangeRow<T>[] = [];
  const all = (node: Directory<T>): T[] => [
    ...[...node.directories.values()].flatMap(all),
    ...node.files,
  ];
  const visit = (node: Directory<T>, prefix: string, depth: number) => {
    for (const [name, child] of [...node.directories].sort(([a], [b]) => byPath(a, b))) {
      let label = name;
      let directory = child;
      while (!directory.files.length && directory.directories.size === 1) {
        const [next, only] = [...directory.directories][0];
        label = `${label}/${next}`;
        directory = only;
      }
      const path = prefix ? `${prefix}/${label}` : label;
      rows.push({ kind: 'directory', path, label, depth, files: all(directory) });
      if (!collapsed.has(path)) visit(directory, path, depth + 1);
    }
    for (const file of [...node.files].sort((a, b) => byPath(a.path, b.path)))
      rows.push({ kind: 'file', file, label: file.path.split('/').pop()!, depth });
  };
  visit(root, '', 0);
  return rows;
}
