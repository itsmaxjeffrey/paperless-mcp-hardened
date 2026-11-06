import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createServer as createNodeServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Wire-level test: real MCP SDK StreamableHTTPServerTransport and the real
// server registration run behind the real HTTP handler; only the Paperless
// REST backend is mocked (no live Paperless connection).
const fsRoot = mkdtempSync(join(tmpdir(), "mcp-wire-"));
vi.stubEnv("PAPERLESS_URL", "https://p.example.com");
vi.stubEnv("PAPERLESS_TOKEN", "admin-tok");
vi.stubEnv("PAPERLESS_FS_ROOTS", fsRoot);

const { profileState } = vi.hoisted(() => ({
  profileState: { failFor: new Set<string>() },
}));

vi.mock("../paperless/client.js", () => {
  class PaperlessClient {
    constructor(
      public baseUrl: string,
      public token: string,
    ) {}
    async fetch(path: string) {
      if (path === "/api/profile/") {
        if (profileState.failFor.has(this.token)) throw new Error("401: invalid token credentials");
        return { username: "wire" };
      }
      return { results: [] };
    }
  }
  return { PaperlessClient };
});

const { createHttpHandler } = await import("../http.js");

const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

function parseResponse(text: string, contentType: string): Record<string, unknown> {
  if (contentType.includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      if (line.startsWith("data:")) return JSON.parse(line.slice(5).trim());
    }
    throw new Error(`no SSE data frame in: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
}

describe("MCP wire behavior (real SDK transport)", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const handler = createHttpHandler();
    server = createNodeServer(handler);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(
    () =>
      new Promise<void>((r) => {
        server.close(() => r());
      }),
  );

  const post = (token: string, body: unknown, sessionId?: string) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        ...HEADERS,
        Authorization: `Bearer ${token}`,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(body),
    });

  async function initialize(token: string) {
    const r = await post(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "wire-test", version: "1" },
      },
    });
    const payload = parseResponse(await r.text(), r.headers.get("content-type") || "");
    return { status: r.status, sessionId: r.headers.get("mcp-session-id"), payload };
  }

  it("answers 401 for an invalid token before any MCP processing", async () => {
    profileState.failFor.add("bad-token");
    const { status } = await initialize("bad-token");
    expect(status).toBe(401);
  });

  it("completes a real SDK initialize handshake with a valid token", async () => {
    const { status, sessionId, payload } = await initialize("good-token");
    expect(status).toBe(200);
    expect(sessionId).toBeTruthy();
    const result = payload.result as { serverInfo?: { name?: string } } | undefined;
    expect(result?.serverInfo?.name).toBe("paperless-mcp");
  });

  it("answers 401 with the real transport after token revocation", async () => {
    const { sessionId } = await initialize("revoked-token");
    expect(sessionId).toBeTruthy();
    profileState.failFor.add("revoked-token");
    const r = await post(
      "revoked-token",
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      sessionId!,
    );
    expect(r.status).toBe(401);
    await r.text();
  });

  it("lists tools over the wire but never exposes filesystem tools, even with PAPERLESS_FS_ROOTS configured", async () => {
    const { sessionId } = await initialize("lister-token");
    const r = await post(
      "lister-token",
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
      sessionId!,
    );
    expect(r.status).toBe(200);
    const payload = parseResponse(await r.text(), r.headers.get("content-type") || "");
    const tools = (payload.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(tools.length).toBeGreaterThan(10);
    expect(tools).toContain("list_documents");
    const forbidden = [
      "upload_document",
      "upload_document_version",
      "bulk_download_documents",
      "extract_document_pages",
    ];
    for (const name of forbidden) expect(tools).not.toContain(name);
  });
});
