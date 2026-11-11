import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    if ((await stat(path)).size > 8 * 1024 * 1024)
      throw new Error('Deployment state exceeds its size limit.');
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}
export async function writeJson(directory: string, name: string, value: unknown) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, '.' + randomUUID());
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(directory, name));
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
/** Hash and optionally snapshot the exact bytes read, without following a final symlink. */
export async function localContent(path: string, snapshot?: string, signal?: AbortSignal) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (snapshot) output = await open(snapshot, 'wx', 0o600);
    const before = await file.stat();
    if (!before.isFile() || before.size > 1024 * 1024 * 1024)
      throw new Error('Local file is not regular or exceeds 1 GiB.');
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const data of file.createReadStream({ autoClose: false })) {
      signal?.throwIfAborted();
      const chunk = Buffer.from(data);
      bytes += chunk.length;
      if (bytes > 1024 * 1024 * 1024) throw new Error('Local file grew beyond the transfer limit.');
      hash.update(chunk);
      if (output) await output.writeFile(chunk);
    }
    const after = await file.stat();
    if (
      before.size !== bytes ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino
    )
      throw new Error('Local file changed while reading. Preview again.');
    return { hash: hash.digest('hex'), bytes, mtime: before.mtimeMs };
  } finally {
    await output?.close();
    await file.close();
  }
}
export async function localText(path: string, expected: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    const limit = 1024 * 1024;
    if (!info.isFile() || info.size > limit)
      throw new Error('Text comparison supports regular files up to 1 MiB.');
    const buffer = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await file.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const content = buffer.subarray(0, count);
    if (count > limit || createHash('sha256').update(content).digest('hex') !== expected)
      throw new Error('Local file changed since preview. Preview again.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(content);
    if (text.includes('\0')) throw new Error('Binary files cannot be compared as text.');
    return text;
  } finally {
    await file.close();
  }
}
