import { config } from "../config.js";

export async function readBoundedResponse(
  res: Response,
  what: string,
  maxBytes: number = config.maxDownloadBytes,
): Promise<Buffer> {
  // Content-Length is only an early reject: a server may omit it or lie, so
  // the streamed byte count below is the real bound.
  const declared = Number(res.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new Error(
      `${what} is larger than the configured download limit (${declared} > ${maxBytes} bytes)`,
    );
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error(`${what}: response has no readable body`);
  const timeoutMs = config.downloadTimeoutMs;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what}: body read timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes)
        throw new Error(
          `${what} exceeds the configured download limit while streaming (${maxBytes} bytes)`,
        );
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } catch (e) {
    try {
      await reader.cancel(e instanceof Error ? e : undefined);
    } catch {
      // already errored or locked; nothing more to release
    }
    throw e;
  } finally {
    clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {
      // lock already released by cancel()
    }
  }
}
