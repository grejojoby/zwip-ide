import { request } from '../../api';
import type { GoResult } from '../../model/go-types';
export async function goTool(
  method: string,
  params: Record<string, unknown> = {},
): Promise<GoResult> {
  const result = await request<GoResult>('tool.request', {
    packageId: 'go',
    method,
    params,
    synchronizeDocuments:
      method === 'run.start' || method === 'test.start' || method === 'debug.start',
  });
  if (result.state !== 'complete')
    throw new Error(result.reasons.join('\n') || `${method}: ${result.state}`);
  return result;
}
