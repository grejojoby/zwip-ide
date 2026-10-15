import type { NavigationBatch, Position, SourceLocation } from '../contracts';

export function containsPosition(
  location: SourceLocation,
  path: string,
  position: Position,
): boolean {
  const { start, end } = location.range;
  return (
    location.path === path &&
    (position.line > start.line ||
      (position.line === start.line && position.character >= start.character)) &&
    // A keyboard invocation can place the caret just after the declaration's name.
    (position.line < end.line ||
      (position.line === end.line && position.character <= end.character))
  );
}

export function shouldFindUsages(
  locations: SourceLocation[],
  path: string,
  position: Position,
): boolean {
  return (
    locations.length > 0 &&
    locations.every((location) => containsPosition(location, path, position))
  );
}

export function isCurrentResult(
  batch: NavigationBatch,
  id: string,
  revision: number,
  generation: number,
): boolean {
  return (
    batch.id === id &&
    batch.documentRevision === revision &&
    batch.workspaceGeneration === generation
  );
}

export class NavigationHistory {
  private entries: { path: string; position: Position; sourceContextId?: string }[] = [];
  private cursor = -1;
  visit(path: string, position: Position, sourceContextId?: string): void {
    const previous = this.entries[this.cursor];
    if (
      previous?.path === path &&
      previous.sourceContextId === sourceContextId &&
      previous.position.line === position.line &&
      previous.position.character === position.character
    )
      return;
    this.entries = this.entries.slice(0, this.cursor + 1);
    this.entries.push({ path, position, ...(sourceContextId ? { sourceContextId } : {}) });
    if (this.entries.length > 100) this.entries.shift();
    this.cursor = this.entries.length - 1;
  }
  back() {
    return this.cursor > 0 ? this.entries[--this.cursor] : undefined;
  }
  forward() {
    return this.cursor < this.entries.length - 1 ? this.entries[++this.cursor] : undefined;
  }
  relocate(path: string, destination?: string): void {
    if (destination) {
      this.entries = this.entries.map((entry) =>
        entry.path === path ? { ...entry, path: destination, sourceContextId: undefined } : entry,
      );
      return;
    }
    const retainedBeforeCursor = this.entries
      .slice(0, this.cursor + 1)
      .filter((entry) => entry.path !== path).length;
    this.entries = this.entries.filter((entry) => entry.path !== path);
    this.cursor = retainedBeforeCursor - 1;
  }
}
