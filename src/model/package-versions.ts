// Package manifests and catalogs are validated as SemVer by the native package manager.
function parts(version: string) {
  const [release, ...prerelease] = version.split('+')[0].split('-');
  return {
    release: release.split('.').map((part) => BigInt(part)),
    prerelease: prerelease.length ? prerelease.join('-').split('.') : [],
  };
}

/** Compare validated package versions by SemVer precedence, ignoring build metadata. */
export function comparePackageVersions(left: string, right: string): number {
  const a = parts(left);
  const b = parts(right);
  for (let i = 0; i < 3; i++) {
    if (a.release[i] !== b.release[i]) return a.release[i] < b.release[i] ? -1 : 1;
  }
  if (!a.prerelease.length || !b.prerelease.length)
    return a.prerelease.length ? -1 : b.prerelease.length ? 1 : 0;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
