import { describe, expect, it } from 'vitest';
import { newDeploymentServer } from '../../src/model/deployment-contracts';
import {
  destination,
  excluded,
  relativePath,
  validateSettings,
} from '../../packages/tools/src/deployment/paths';
describe('deployment path contract', () => {
  it('rejects traversal, absolute local paths, invalid roots and duplicate mappings', () => {
    for (const path of ['../secret', 'a/../../b', '/etc/passwd', 'a\\b', 'a\0b'])
      expect(() => relativePath(path)).toThrow();
    const server = {
      ...newDeploymentServer('server'),
      name: 'Test',
      host: 'localhost',
      username: 'user',
      fingerprint: 'SHA256:' + 'a'.repeat(43),
    };
    expect(
      validateSettings({ revision: 0, servers: [server], defaultId: 'server', autoUpload: 'never' })
        .servers[0],
    ).toEqual(server);
    expect(() =>
      validateSettings({
        servers: [
          {
            ...server,
            mappings: [
              { local: '.', remote: '' },
              { local: '.', remote: 'other' },
            ],
          },
        ],
      }),
    ).toThrow();
  });
  it('uses the most specific local mapping and keeps remote paths relative to the root', () => {
    const server = newDeploymentServer('server');
    server.mappings = [
      { local: '.', remote: 'app' },
      { local: 'assets', remote: '/static' },
    ];
    expect(destination(server, 'assets/css/site.css')).toBe('static/css/site.css');
    expect(destination(server, 'index.html')).toBe('app/index.html');
    server.mappings = [{ local: 'assets', remote: 'static' }];
    expect(destination(server, 'private.txt')).toBeNull();
  });
  it('excludes subtrees and filename patterns at every depth without treating siblings as children', () => {
    const server = newDeploymentServer('server');
    server.excludedLocal = ['private'];
    server.excludedRemote = ['cache'];
    for (const [local, remote] of [
      ['private/a.txt', 'a'],
      ['src/.env.local', 'a'],
      ['src/key.pem', 'a'],
      ['a', 'cache/b'],
    ])
      expect(excluded(server, local, remote)).toBe(true);
    expect(excluded(server, 'private-other/a.txt', 'cached/a')).toBe(false);
    server.excludeNames = 'style?.css';
    expect(excluded(server, 'styles/style1.css', 'x')).toBe(true);
    expect(excluded(server, 'styles/style.css', 'x')).toBe(false);
  });
});
