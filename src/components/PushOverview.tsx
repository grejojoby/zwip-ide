import { useEffect, useState } from 'react';
import { request } from '../api';
import type { GitDiff, PushPlan } from '../contracts';
import { changeTree } from '../model/change-tree';
import { FileIcon } from './FileIcon';
import { Icon } from './Icon';
import { PatchView } from './PatchView';
import { PartialDiff } from './PartialDiff';
import { asError } from '../model/document-session';

export function PushOverview({ plan, onEdit }: { plan: PushPlan; onEdit?(): void }) {
  const [selected, setSelected] = useState<string | null>(plan.files[0] ?? null);
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const rows = changeTree(
    plan.files.map((path) => ({ path })),
    collapsed,
  );
  return (
    <div className="push-content">
      <aside className="push-commits" aria-label="Outgoing commits">
        <div className="push-branch-route">
          <Icon name="branch" />
          <strong>{plan.branch}</strong>
          <span aria-hidden="true">→</span>
          <strong>
            {plan.remote} :{' '}
            {plan.upstream.startsWith(`${plan.remote}/`)
              ? plan.upstream.slice(plan.remote.length + 1)
              : plan.upstream}
          </strong>
        </div>
        <h3>
          {plan.commits.length} outgoing {plan.commits.length === 1 ? 'commit' : 'commits'}
        </h3>
        {plan.commits.map((commit) => (
          <div key={commit.id} className="push-commit">
            <strong title={commit.subject}>{commit.subject}</strong>
            <span>
              <code>{commit.id.slice(0, 8)}</code> · {commit.author}
            </span>
          </div>
        ))}
        {!plan.commits.length && <p className="empty-note">No commits to push.</p>}
      </aside>
      <div className="push-review">
        <section className="push-files-card" aria-label="Changed files">
          <h3>
            <Icon name="folder" />
            Changed files <span className="muted">{plan.files.length}</span>
          </h3>
          <div className="push-file-tree">
            {rows.map((row) => {
              const directory = row.kind === 'directory';
              const path = directory ? row.path : row.file.path;
              return (
                <button
                  key={`${row.kind}:${path}`}
                  className={`push-file${!directory && selected === path ? ' selected' : ''}`}
                  style={{ paddingLeft: 8 + row.depth * 16 }}
                  title={path}
                  aria-label={path}
                  aria-expanded={directory ? !collapsed.has(path) : undefined}
                  aria-pressed={directory ? undefined : selected === path}
                  onClick={() => {
                    if (!directory) setSelected(path);
                    else
                      setCollapsed((current) => {
                        const next = new Set(current);
                        if (next.has(path)) next.delete(path);
                        else next.add(path);
                        return next;
                      });
                  }}
                >
                  {directory ? (
                    <>
                      <Icon
                        name="chevron"
                        style={{ transform: collapsed.has(path) ? undefined : 'rotate(90deg)' }}
                      />
                      <Icon name="folder" />
                    </>
                  ) : (
                    <FileIcon path={path} />
                  )}
                  <span>{row.label}</span>
                  {directory && <span className="muted">{row.files.length}</span>}
                </button>
              );
            })}
            {!plan.files.length && <p className="empty-note">No outgoing file changes.</p>}
          </div>
        </section>
        {selected ? (
          <section className="push-diff-card" aria-label="Code changes">
            <h3>
              <FileIcon path={selected} />
              <span>{selected}</span>
            </h3>
            {Object.hasOwn(plan.filePatches, selected) ? (
              <OutgoingDiff key={selected} path={selected} plan={plan} onEdit={onEdit} />
            ) : (
              <p role="alert" className="empty-note">
                Preview unavailable. Close and reopen the push overview.
              </p>
            )}
          </section>
        ) : (
          <p className="push-preview-hint">Select a file to review its outgoing code changes.</p>
        )}
      </div>
    </div>
  );
}

function OutgoingDiff({ path, plan, onEdit }: { path: string; plan: PushPlan; onEdit?(): void }) {
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    request<GitDiff>('git.compareFile', {
      branch: plan.base ?? plan.upstream,
      revision: plan.head ?? 'HEAD',
      path,
    })
      .then((result) => {
        if (active && result.path) setDiff(result);
      })
      .catch((e) => {
        if (active) setError(asError(e).message);
      });
    return () => {
      active = false;
    };
  }, [path, plan, revision]);
  return (
    <>
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      {diff ? (
        <PartialDiff
          diff={diff}
          selected={null}
          onSelect={() => {}}
          readOnly
          onEdit={onEdit}
          onReverted={() => {
            setDiff(null);
            setRevision((value) => value + 1);
          }}
        />
      ) : (
        <PatchView patch={plan.filePatches[path]} />
      )}
    </>
  );
}
