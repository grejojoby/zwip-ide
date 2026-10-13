import { resultPreview } from './result-preview';

/** SCAN COUNT is a hint; enforce payload limits independently of its page size. */
export function redisPreview(input: unknown): { value: unknown; truncated: boolean } {
  return resultPreview(input, { bytes: 512 * 1024, nodes: 2048 });
}
