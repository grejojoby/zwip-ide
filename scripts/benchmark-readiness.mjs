/** Polls explicit context coverage without hiding provider startup failures. */
export async function waitForReadiness(request, expected, packageIds, options = {}) {
  const started = performance.now();
  const timeoutMs = options.timeoutMs ?? 240000;
  const intervalMs = options.intervalMs ?? 250;
  let lastSignature;
  for (;;) {
    const contexts = (await request('workspace.status')).contexts;
    const packages = (await request('package.list')).filter((item) => packageIds.includes(item.id));
    const diagnostics = {
      elapsedMs: performance.now() - started,
      contexts,
      packages: packages.map(({ id, enabled, running, error }) => ({
        id,
        enabled,
        running,
        error,
      })),
      missingContextIds: expected
        .filter((context) => !contexts.some((state) => state.id === context.id))
        .map((context) => context.id),
    };
    const signature = JSON.stringify([
      contexts,
      diagnostics.packages,
      diagnostics.missingContextIds,
    ]);
    if (signature !== lastSignature) {
      options.onProgress?.(diagnostics);
      lastSignature = signature;
    }
    const failures = [
      ...packages.filter((item) => item.error).map((item) => `${item.id}: ${item.error}`),
      ...contexts
        .filter(
          (state) => state.state === 'failed' && expected.some((item) => item.id === state.id),
        )
        .map((state) => `${state.id}: ${state.reason ?? 'context failed'}`),
    ];
    const complete = expected.every((context) =>
      contexts.some((state) => state.id === context.id && state.state === 'ready'),
    );
    if (failures.length || (!complete && performance.now() - started >= timeoutMs)) {
      const error = new Error(
        failures.length
          ? `Provider readiness failed: ${failures.join('; ')}`
          : 'Provider readiness timed out before all expected contexts became ready.',
      );
      error.diagnostics = diagnostics;
      throw error;
    }
    if (complete) return diagnostics;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
