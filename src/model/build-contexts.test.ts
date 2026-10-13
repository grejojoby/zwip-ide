import { describe, expect, it } from 'vitest';
import type { BuildContext } from '../contracts';
import { mergeContextUpdates, sourceContexts } from './build-contexts';

const context = (
  id: string,
  root: string,
  extensions: string[],
  profileId?: string,
): BuildContext => ({
  id,
  root,
  documentExtensions: extensions,
  profileId,
  language: 'package-defined',
  configPath: `${root}/project.config`,
  state: 'ready',
});
describe('source build contexts', () => {
  it('retains generic package metadata when a provider only reports readiness', () => {
    const profile = context('module#linux', '/repo/service', ['.go'], 'linux');
    const provider: BuildContext = {
      id: profile.id,
      root: profile.root,
      language: profile.language,
      configPath: profile.configPath,
      state: 'failed',
      reason: 'SDK unavailable',
    };
    const updated = mergeContextUpdates([profile], [provider]);
    expect(sourceContexts('/repo/service/main.go', updated)).toEqual([
      { ...profile, state: 'failed', reason: 'SDK unavailable' },
    ]);
  });
  it('keeps nearest-project defaults and explicit profiles while excluding other language packages', () => {
    const contexts = [
      context('outer', '/repo', ['go']),
      context('module-default', '/repo/service', ['.go']),
      context('module-linux', '/repo/service', ['.go'], 'linux'),
      context('web', '/repo/service', ['.ts', '.tsx'], 'browser'),
      context('other-module', '/repo/service-copy', ['.go'], 'linux'),
    ];
    expect(
      sourceContexts('/repo/service/handlers/main.go', contexts).map((item) => item.id),
    ).toEqual(['module-default', 'module-linux']);
    expect(sourceContexts('/repo/service/page.tsx', contexts).map((item) => item.id)).toEqual([
      'web',
    ]);
  });
  it('does not invent support for missing metadata or dependency sources outside project roots', () => {
    const current = context('current', '/repo', ['.ts'], 'test');
    expect(sourceContexts('/repo-copy/file.ts', [current])).toEqual([]);
    expect(sourceContexts('/cache/dependency/file.ts', [current])).toEqual([]);
    expect(
      sourceContexts('/repo/file.ts', [{ ...current, documentExtensions: undefined }]),
    ).toEqual([]);
  });
});
