import { describe, expect, it } from 'vitest';
// @ts-expect-error The standalone benchmark helper runs directly in Node.
import { waitForReadiness } from '../../scripts/benchmark-readiness.mjs';

describe('benchmark provider readiness', () => {
  const expected = [{ id: 'project', language: 'web' }];
  it('allows loading and unavailable probes until the expected context becomes ready', async () => {
    let polls = 0;
    const result = await waitForReadiness(
      async (method: string) =>
        method === 'package.list'
          ? [{ id: 'web', enabled: true, running: true, error: null }]
          : { contexts: [{ id: 'project', state: ['loading', 'unavailable', 'ready'][polls++] }] },
      expected,
      ['web'],
      { intervalMs: 0 },
    );
    expect(polls).toBe(3);
    expect(result.missingContextIds).toEqual([]);
  });

  it('fails immediately with the actual worker error rather than waiting for missing contexts', async () => {
    const request = async (method: string) =>
      method === 'package.list'
        ? [{ id: 'web', enabled: true, running: false, error: 'Language worker exited' }]
        : { contexts: [] };
    await expect(waitForReadiness(request, expected, ['web'])).rejects.toMatchObject({
      message: 'Provider readiness failed: web: Language worker exited',
      diagnostics: { missingContextIds: ['project'] },
    });
  });

  it('preserves failed context reasons even while another context is loading', async () => {
    await expect(
      waitForReadiness(
        async (method: string) =>
          method === 'package.list'
            ? []
            : {
                contexts: [
                  { id: 'project', state: 'failed', reason: 'SDK unavailable' },
                  { id: 'other', state: 'loading' },
                ],
              },
        [...expected, { id: 'other' }],
        ['web'],
      ),
    ).rejects.toThrow('project: SDK unavailable');
  });

  it('reports missing coverage on timeout and never treats a non-running extension as a failure', async () => {
    await expect(
      waitForReadiness(
        async (method: string) =>
          method === 'package.list'
            ? [{ id: 'react-next', enabled: true, running: false, error: null }]
            : { contexts: [] },
        expected,
        ['react-next'],
        { timeoutMs: 0 },
      ),
    ).rejects.toMatchObject({ diagnostics: { missingContextIds: ['project'] } });
  });
});
