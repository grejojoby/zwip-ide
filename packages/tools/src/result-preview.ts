export interface PreviewLimits {
  bytes: number;
  nodes: number;
}
const omitted = Symbol('omitted');

/** Bounds serialization work as well as the final UTF-8 JSON payload. Driver
 * decoding happens before this boundary; this is not a wire-allocation limit. */
export function resultPreview(input: unknown, limits: PreviewLimits) {
  let remaining = limits.bytes;
  let nodes = limits.nodes;
  let truncated = false;
  const ancestors = new Set<object>();
  const omit = () => {
    truncated = true;
    return omitted;
  };
  const scalar = (value: unknown): unknown | typeof omitted => {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > remaining) return omit();
    remaining -= bytes;
    return value;
  };
  function visit(value: unknown, depth: number): unknown | typeof omitted {
    if (remaining < 4 || nodes-- <= 0 || depth > 24) return omit();
    if (typeof value === 'string') {
      if (value.length <= 65536 && value.length + 2 <= remaining) {
        const bytes = Buffer.byteLength(JSON.stringify(value));
        if (bytes <= remaining) {
          remaining -= bytes;
          return value;
        }
      }
      // One UTF-16 unit needs at most six JSON bytes. Inspect only a bounded
      // prefix, even for a single very large value from a database driver.
      let limit = Math.min(65536, Math.max(0, Math.floor((remaining - 32) / 6)));
      if (limit > 0 && /[\uD800-\uDBFF]/.test(value[limit - 1])) limit--;
      truncated = true;
      return scalar(`${value.slice(0, limit)}… [truncated]`);
    }
    if (typeof value === 'bigint') return visit(value.toString(), depth);
    if (value === null || typeof value === 'number' || typeof value === 'boolean')
      return scalar(value);
    if (value instanceof Uint8Array) {
      const limit = Math.min(65536, Math.max(0, Math.floor(((remaining - 64) * 3) / 4)));
      truncated ||= value.byteLength > limit;
      return scalar({
        type: 'bytes',
        base64: Buffer.from(value.subarray(0, limit)).toString('base64'),
      });
    }
    if (!value || typeof value !== 'object' || ancestors.has(value)) return omit();
    if (value instanceof Date) return visit(value.toISOString(), depth);
    ancestors.add(value);
    remaining -= 2;
    if (Array.isArray(value)) {
      const output: unknown[] = [];
      for (const entry of value) {
        if (output.length) remaining--;
        const item = visit(entry, depth + 1);
        if (item === omitted) break;
        output.push(item);
      }
      ancestors.delete(value);
      return output;
    }
    const output: Record<string, unknown> = Object.create(null);
    let count = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (key.length > 65536 || key.length * 6 + 8 > remaining || nodes <= 0) {
        truncated = true;
        break;
      }
      remaining -= Buffer.byteLength(JSON.stringify(key)) + 1 + (count ? 1 : 0);
      const item = visit((value as Record<string, unknown>)[key], depth + 1);
      if (item === omitted) break;
      output[key] = item;
      count++;
    }
    ancestors.delete(value);
    return output;
  }
  const value = visit(input, 0);
  return { value: value === omitted ? null : value, truncated };
}
