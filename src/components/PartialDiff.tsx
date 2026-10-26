import { useState } from 'react';
import type { DiffLine, GitDiff } from '../contracts';
import { PatchView } from './PatchView';
import { DiffActions } from './DiffActions';
interface SideRow {
  left?: DiffLine;
  right?: DiffLine;
}
/** Pairs removed and added runs on one row each, like GitHub's split view. */
function sideRows(lines: DiffLine[]): SideRow[] {
  const rows: SideRow[] = [];
  for (let at = 0; at < lines.length;) {
    if (lines[at].kind === 'context') {
      rows.push({ left: lines[at], right: lines[at] });
      at += 1;
      continue;
    }
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (at < lines.length && lines[at].kind !== 'context') {
      (lines[at].kind === 'remove' ? removed : added).push(lines[at]);
      at += 1;
    }
    for (let row = 0; row < Math.max(removed.length, added.length); row += 1)
      rows.push({ left: removed[row], right: added[row] });
  }
  return rows;
}

export function PartialDiff({
  diff,
  selected,
  onSelect,
  readOnly = false,
  onReverted,
  onEdit,
}: {
  diff: GitDiff;
  selected: Set<string> | null;
  onSelect(ids: Set<string>): void;
  readOnly?: boolean;
  onReverted?(): void | Promise<void>;
  onEdit?(): void;
}) {
  const [mode, setMode] = useState<'unified' | 'side'>('unified');
  const changes = diff.hunks.flatMap((hunk) =>
    hunk.lines.filter((line) => line.kind !== 'context').map((line) => line.id),
  );
  const isSelected = (id: string) => selected === null || selected.has(id);
  function toggle(ids: string[], checked: boolean) {
    const next = new Set(selected ?? changes);
    for (const id of ids)
      if (checked) next.add(id);
      else next.delete(id);
    onSelect(next);
  }
  return (
    <>
      <div className="diff-title">
        <strong>{diff.path}</strong>
        <div className="spacer" />
        <DiffActions
          key={`${diff.path}:${diff.fingerprint}`}
          diff={diff}
          onReverted={onReverted}
          onEdit={onEdit}
        />
        <button aria-pressed={mode === 'unified'} onClick={() => setMode('unified')}>
          Unified
        </button>
        <button aria-pressed={mode === 'side'} onClick={() => setMode('side')}>
          Side by side
        </button>
      </div>
      {diff.binary ? (
        <p className="empty-note">Binary file · text diff unavailable</p>
      ) : !diff.hunks.length ? (
        <PatchView patch={diff.patch} />
      ) : (
        <div className={mode === 'side' ? 'selectable-diff split-diff' : 'selectable-diff'}>
          {!diff.partialAllowed && (
            <p className="inline-notice">{diff.kind} change · commit this file as a whole.</p>
          )}
          {diff.hunks.map((hunk) => {
            const ids = hunk.lines.filter((line) => line.kind !== 'context').map((line) => line.id);
            const box = (line: DiffLine) =>
              !readOnly && diff.partialAllowed && line.kind !== 'context' ? (
                <input
                  type="checkbox"
                  aria-label={`Include ${line.kind} at line ${line.newLine ?? line.oldLine}`}
                  checked={isSelected(line.id)}
                  onChange={(e) => toggle([line.id], e.target.checked)}
                />
              ) : (
                <span className="checkbox-spacer" />
              );
            const state = (line: DiffLine) =>
              readOnly &&
              line.kind !== 'context' && (
                <span className="commit-line-state">
                  {isSelected(line.id) ? 'included' : 'excluded'}
                </span>
              );
            const excluded = (line: DiffLine) =>
              readOnly && line.kind !== 'context' && !isSelected(line.id) ? 'not-in-commit' : '';
            return (
              <div key={hunk.id} className="diff-block">
                <div className="diff-hunk-title">
                  {!readOnly && diff.partialAllowed && (
                    <input
                      type="checkbox"
                      aria-label={`Include hunk at line ${hunk.newStart}`}
                      checked={ids.length > 0 && ids.every(isSelected)}
                      onChange={(e) => toggle(ids, e.target.checked)}
                    />
                  )}
                  <code>
                    @@ −{hunk.oldStart} +{hunk.newStart} @@
                  </code>
                  <DiffActions
                    key={`${diff.path}:${diff.fingerprint}:${hunk.id}`}
                    diff={diff}
                    changeIds={ids}
                    label={`Revert hunk at line ${hunk.newStart}…`}
                    onReverted={onReverted}
                  />
                </div>
                {mode === 'side'
                  ? sideRows(hunk.lines).map((row, index) => (
                      <div key={index} className="split-diff-row">
                        {[row.left, row.right].map((line, side) => (
                          <div
                            key={side}
                            className={`split-diff-cell ${
                              !line
                                ? 'split-diff-empty'
                                : line.kind === 'add'
                                  ? 'diff-added'
                                  : line.kind === 'remove'
                                    ? 'diff-removed'
                                    : ''
                            } ${line ? excluded(line) : ''}`}
                          >
                            {line ? box(line) : <span className="checkbox-spacer" />}
                            <span className="diff-line-number">
                              {line && (side === 0 ? line.oldLine : line.newLine)}
                            </span>
                            <code>
                              {line && (
                                <>
                                  {line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}
                                  {line.text}
                                </>
                              )}
                            </code>
                            {line && state(line)}
                          </div>
                        ))}
                      </div>
                    ))
                  : hunk.lines.map((line, index) => (
                      <div
                        key={`${line.id}:${index}`}
                        className={`selectable-diff-line ${line.kind === 'add' ? 'diff-added' : line.kind === 'remove' ? 'diff-removed' : ''} ${excluded(line)}`}
                      >
                        {box(line)}
                        <span className="diff-line-number">{line.oldLine}</span>
                        <span className="diff-line-number">{line.newLine}</span>
                        <code>
                          {line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}
                          {line.text}
                        </code>
                        {state(line)}
                      </div>
                    ))}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
