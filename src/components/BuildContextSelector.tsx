import { useMemo } from 'react';
import type { BuildContext } from '../contracts';
import { sourceContexts } from '../model/build-contexts';

export function BuildContextSelector({
  path,
  contexts,
  value,
  onChange,
}: {
  path: string;
  contexts: BuildContext[];
  value?: string;
  onChange(value?: string): void;
}) {
  const eligible = useMemo(() => sourceContexts(path, contexts), [path, contexts]);
  if (!eligible.some((context) => context.profileId)) return null;
  const unknown = value && !eligible.some((context) => context.id === value);
  return (
    <select
      className="build-context-selector"
      aria-label={`Build context for ${path.split('/').pop()}`}
      title="Source build context for semantic operations"
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value || undefined)}
    >
      <option value="">Default context (automatic)</option>
      {unknown && (
        <option value={value} disabled>
          Unavailable selected context
        </option>
      )}
      {eligible.map((context) => (
        <option key={context.id} value={context.id}>
          {context.profileId ?? 'Default'} · {context.configPath.split('/').pop()}
          {context.state === 'ready' ? '' : ` · ${context.state}`}
        </option>
      ))}
    </select>
  );
}
