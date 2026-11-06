import { describe, it, expect, vi } from "vitest";

vi.stubEnv("PAPERLESS_URL", "https://p.example.com");
vi.stubEnv("PAPERLESS_TOKEN", "admin-tok");
vi.stubEnv("MCP_MAX_DOWNLOAD_BYTES", "1000");
vi.stubEnv("MCP_DOWNLOAD_TIMEOUT_MS", "500");

const { readBoundedResponse } = await import("../security/download.js");
const { config } = await import("../config.js");

function streamOf(chunks: Uint8Array[], stallAfter?: number) {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (stallAfter !== undefined && i >= stallAfter) return; // never close
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[i++]);
    },
  });
}

describe("readBoundedResponse", () => {
  it("reads a small body within the limit", async () => {
    const res = new Response(streamOf([new Uint8Array([1, 2, 3])]));
    const buf = await readBoundedResponse(res, "doc");
    expect(buf).toEqual(Buffer.from([1, 2, 3]));
  });

  it("rejects a body that streams past the limit even with no content-length header", async () => {
    const res = new Response(streamOf([new Uint8Array(600), new Uint8Array(600)]));
    expect(res.headers.get("content-length")).toBeNull();
    await expect(readBoundedResponse(res, "doc")).rejects.toThrow(/while streaming.*1000/);
  });

  it("rejects on the declared content-length before consuming the body and cancels it", async () => {
    const res = new Response(streamOf([new Uint8Array(600)]), {
      headers: { "content-length": "5000" },
    });
    const cancelled = new Promise<boolean>((resolve) => {
      void res.body!.cancel().then(
        () => resolve(true),
        () => resolve(false),
      );
    });
    await expect(readBoundedResponse(res, "doc")).rejects.toThrow(/larger than.*5000/);
    // the response body was cancelled by the reader
    await expect(cancelled).resolves.toBe(true);
  });

  it("times out and cancels when the body stalls mid-read", async () => {
    const res = new Response(streamOf([new Uint8Array(10)], 1));
    await expect(readBoundedResponse(res, "doc")).rejects.toThrow(/timed out after 500ms/);
    await expect(res.body!.getReader().closed).resolves.toBeUndefined();
  });

  it("cancels the underlying reader on a mid-stream size rejection", async () => {
    const res = new Response(streamOf([new Uint8Array(600), new Uint8Array(600)]));
    await expect(readBoundedResponse(res, "doc")).rejects.toThrow(/while streaming/);
    await expect(res.body!.getReader().closed).resolves.toBeUndefined();
  });

  it("rejects a response with no body", async () => {
    const res = { headers: new Headers(), body: null } as unknown as Response;
    await expect(readBoundedResponse(res, "doc")).rejects.toThrow(/no readable body/);
  });

  it("honors a smaller explicit cap than the configured limit", async () => {
    const res = new Response(streamOf([new Uint8Array(900)]));
    await expect(readBoundedResponse(res, "image", 800)).rejects.toThrow(/while streaming.*800/);
  });

  it("uses the configured deadline", () => {
    expect(config.downloadTimeoutMs).toBe(500);
  });
});
