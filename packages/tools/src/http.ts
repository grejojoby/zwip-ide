export interface HttpInput {
  id: string;
  source: string;
  requestIndex?: number;
  environment?: Record<string, string>;
}
export interface HttpResponse {
  id: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  encoding: 'text' | 'base64';
  bytes: number;
  truncated: boolean;
  durationMs: number;
  url: string;
}
export function parseHttp(
  source: string,
  environment: Record<string, string> = {},
  requestIndex = 0,
) {
  const locals = { ...environment };
  const stripped = source.replace(/^@([\w.-]+)\s*=\s*(.*)$/gm, (_, name: string, value: string) => {
    if (!(name in locals)) locals[name] = value;
    return '';
  });
  const requests = stripped
    .split(/^###.*$/m)
    .map((section) => section.trim())
    .filter((section) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s/m.test(section));
  if (!Number.isInteger(requestIndex) || requestIndex < 0 || !requests[requestIndex])
    throw new Error('Select a request in the HTTP file.');
  const expanded = requests[requestIndex]
    .replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key: string) => {
      if (!(key in locals)) throw new Error(`Missing HTTP environment variable: ${key}`);
      return locals[key];
    })
    .trim();
  const lines = expanded.split(/\r?\n/);
  while (lines[0]?.startsWith('#')) lines.shift();
  const match = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)(?:\s+HTTP\/[\d.]+)?$/.exec(
    lines.shift() ?? '',
  );
  if (!match) throw new Error('Expected METHOD https://host/path on the first request line.');
  const url = new URL(match[2]);
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('Only HTTP and HTTPS requests are supported.');
  if (url.username || url.password) throw new Error('Use an Authorization header for credentials.');
  const headers = new Headers();
  let index = 0;
  for (; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) {
      index++;
      break;
    }
    const separator = line.indexOf(':');
    if (separator <= 0) throw new Error('Malformed request header.');
    headers.append(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  const body = lines.slice(index).join('\n');
  return { url: url.toString(), method: match[1], headers, body: body || undefined };
}
export class HttpService {
  private requests = new Map<string, AbortController>();
  async execute(input: HttpInput): Promise<HttpResponse> {
    if (!input.id || typeof input.source !== 'string')
      throw new Error('Request id and source are required.');
    if (this.requests.has(input.id)) throw new Error('Request id is already running.');
    const request = parseHttp(input.source, input.environment, input.requestIndex);
    const controller = new AbortController();
    this.requests.set(input.id, controller);
    const timer = setTimeout(
      () => controller.abort(new Error('HTTP request exceeded 120 seconds.')),
      120000,
    );
    const start = performance.now();
    try {
      const response = await fetch(request.url, {
        ...request,
        signal: controller.signal,
        redirect: 'manual',
      });
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      let truncated = false;
      const limit = 2 * 1024 * 1024;
      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          const remaining = limit - bytes;
          chunks.push(chunk.value.slice(0, remaining));
          bytes += Math.min(remaining, chunk.value.length);
          if (chunk.value.length > remaining || bytes === limit) {
            truncated = true;
            await reader.cancel();
            break;
          }
        }
      }
      const data = Buffer.concat(chunks);
      const type = response.headers.get('content-type') ?? '';
      const text =
        /text\/|json|xml|javascript|x-www-form-urlencoded/.test(type) || !data.includes(0);
      return {
        id: input.id,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers),
        body: text ? data.toString('utf8') : data.toString('base64'),
        encoding: text ? 'text' : 'base64',
        bytes,
        truncated,
        durationMs: performance.now() - start,
        url: response.url,
      };
    } finally {
      clearTimeout(timer);
      this.requests.delete(input.id);
    }
  }
  cancel(id: string) {
    this.requests.get(id)?.abort(new Error('Request canceled.'));
    return null;
  }
  dispose() {
    for (const controller of this.requests.values()) controller.abort();
    this.requests.clear();
  }
}
