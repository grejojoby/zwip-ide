import type { FileEntry } from '../contracts';
export interface TreeEntry {
  id: string;
  name: string;
  depth: number;
  directory: boolean;
  file?: FileEntry;
}
interface Node {
  id: string;
  name: string;
  children: Map<string, Node>;
  file?: FileEntry;
}

export function buildTree(files: FileEntry[], directories: string[] = []): Node {
  const root: Node = { id: '', name: '', children: new Map() };
  function insert(relativePath: string): Node {
    let node = root;
    const parts = relativePath.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      if (!node.children.has(name))
        node.children.set(name, { id: parts.slice(0, i + 1).join('/'), name, children: new Map() });
      node = node.children.get(name)!;
    }
    return node;
  }
  for (const directory of directories) insert(directory);
  for (const file of files) insert(file.relativePath).file = file;
  return root;
}
export function flattenTree(root: Node, expanded: Set<string>, depth = 0): TreeEntry[] {
  const result: TreeEntry[] = [];
  for (const node of [...root.children.values()].sort(
    (a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name),
  )) {
    result.push({ id: node.id, name: node.name, depth, directory: !node.file, file: node.file });
    if (!node.file && expanded.has(node.id)) result.push(...flattenTree(node, expanded, depth + 1));
  }
  return result;
}
