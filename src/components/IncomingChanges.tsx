import type { GitBranch } from '../contracts';
import { Icon } from './Icon';

export const incomingBranches = (branches: readonly GitBranch[] = []) =>
  branches.filter((branch) => !branch.remote && (branch.behind ?? 0) > 0).length;

export function IncomingChanges({ count, label }: { count: number; label: string }) {
  if (count <= 0) return null;
  return (
    <span className="git-incoming" role="img" aria-label={label} title={label}>
      <Icon name="download" />
      <span aria-hidden="true">{count}</span>
    </span>
  );
}
