import type { BuildContext } from '../contracts';

export function mergeContextUpdates(
  contexts: BuildContext[],
  updates: BuildContext[],
): BuildContext[] {
  const byId = new Map(updates.map((context) => [context.id, context]));
  return contexts.map((context) => ({ ...context, ...byId.get(context.id) }));
}

/** Contexts at a nested project boundary take precedence over enclosing projects. */
export function sourceContexts(path: string, contexts: BuildContext[]): BuildContext[] {
  const candidates = contexts.filter((context) => {
    const root = context.root.replace(/\/$/, '');
    return (
      path.startsWith(`${root}/`) &&
      context.documentExtensions?.some((extension) => {
        const suffix = extension.startsWith('.') ? extension : `.${extension}`;
        return path.toLowerCase().endsWith(suffix.toLowerCase());
      })
    );
  });
  const depth = Math.max(0, ...candidates.map((context) => context.root.replace(/\/$/, '').length));
  return candidates.filter((context) => context.root.replace(/\/$/, '').length === depth);
}
