import { expect, it } from 'vitest';
import { comparePackageVersions } from './package-versions';

it.each([
  ['0.1.3', '0.1.4'],
  ['0.9.0', '0.10.0'],
  ['0.99.99', '1.0.0'],
  ['1.0.0-alpha', '1.0.0-alpha.1'],
  ['1.0.0-alpha.1', '1.0.0-alpha.beta'],
  ['1.0.0-alpha.beta', '1.0.0-beta'],
  ['1.0.0-beta.2', '1.0.0-beta.11'],
  ['1.0.0-beta.11', '1.0.0-rc.1'],
  ['1.0.0-rc.1', '1.0.0'],
  ['1.0.0-alpha-1', '1.0.0-alpha-2'],
  ['9007199254740992.0.0', '9007199254740993.0.0'],
])('orders package %s before %s', (older, newer) => {
  expect(comparePackageVersions(older, newer)).toBe(-1);
  expect(comparePackageVersions(newer, older)).toBe(1);
});

it('treats matching versions and differing build metadata as equal', () => {
  expect(comparePackageVersions('0.2.1', '0.2.1')).toBe(0);
  expect(comparePackageVersions('0.2.1+local', '0.2.1+catalog')).toBe(0);
});
