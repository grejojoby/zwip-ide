import { relative, resolve } from 'node:path';

/** Included source membership excludes dependencies both inside and outside the root. */
export function targetKeys(locations, root, includedSourcePaths) {
  return [
    ...new Set(
      locations
        .filter(
          (location) => !includedSourcePaths || includedSourcePaths.has(resolve(location.path)),
        )
        .map(
          (location) =>
            `${relative(root, location.path)}:${location.range.start.line}:${location.range.start.character}`,
        ),
    ),
  ].sort();
}
