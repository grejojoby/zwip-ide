import { useState } from 'react';
import type { GitDiff } from '../contracts';
import { PatchView } from './PatchView';
export function PartialDiff({
  diff,
  selected,
  onSelect,
  readOnly = false,
}: {
  diff: GitDiff;
  selected: Set<string> | null;
  onSelect(ids: Set<string>): void;
  readOnly?: boolean;
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
        <button aria-pressed={mode === 'unified'} onClick={() => setMode('unified')}>
          Unified
        </button>
        <button aria-pressed={mode === 'side'} onClick={() => setMode('side')}>
          Side by side
        </button>
      </div>
      {diff.binary ? (
        <p className="empty-note">Binary file · text diff unavailable</p>
      ) : mode === 'side' ? (
        <div className="side-diff">
          <div>
            <div className="section-label">HEAD</div>
            <pre>{diff.before}</pre>
          </div>
          <div>
            <div className="section-label">Working tree</div>
            <pre>{diff.after}</pre>
          </div>
        </div>
      ) : !diff.hunks.length ? (
        <PatchView patch={diff.patch} />
      ) : (
        <div className="selectable-diff">
          {!diff.partialAllowed && (
            <p className="inline-notice">{diff.kind} change · commit this file as a whole.</p>
          )}
          {diff.hunks.map((hunk) => {
            const ids = hunk.lines.filter((line) => line.kind !== 'context').map((line) => line.id);
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
                </div>
                {hunk.lines.map((line, index) => (
                  <div
                    key={`${line.id}:${index}`}
                    className={`selectable-diff-line ${line.kind === 'add' ? 'diff-added' : line.kind === 'remove' ? 'diff-removed' : ''} ${readOnly && line.kind !== 'context' && !isSelected(line.id) ? 'not-in-commit' : ''}`}
                  >
                    {!readOnly && diff.partialAllowed && line.kind !== 'context' ? (
                      <input
                        type="checkbox"
                        aria-label={`Include ${line.kind} at line ${line.newLine ?? line.oldLine}`}
                        checked={isSelected(line.id)}
                        onChange={(e) => toggle([line.id], e.target.checked)}
                      />
                    ) : (
                      <span className="checkbox-spacer" />
                    )}
                    <span className="diff-line-number">{line.oldLine}</span>
                    <span className="diff-line-number">{line.newLine}</span>
                    <code>
                      {line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}
                      {line.text}
                    </code>
                    {readOnly && line.kind !== 'context' && (
                      <span className="commit-line-state">
                        {isSelected(line.id) ? 'included' : 'excluded'}
                      </span>
                    )}
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
