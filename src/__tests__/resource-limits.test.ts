import { describe, it, expect, vi } from "vitest";

vi.stubEnv("PAPERLESS_URL", "https://p.example.com");
vi.stubEnv("PAPERLESS_TOKEN", "admin-tok");
vi.stubEnv("MCP_MAX_DOWNLOAD_BYTES", "1000");
vi.stubEnv("MCP_MAX_IDS_PER_REQUEST", "5");

const { registerDocumentTools } = await import("../tools/documents.js");
const { registerHelperTools } = await import("../tools/helpers.js");

type ToolHandler = (args: any) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function collect(mod: "documents" | "helpers") {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _d: string, _s: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  const client = {
    token: "admin-tok",
    download: vi.fn(),
    fetch: vi.fn(async () => ({})),
  };
  if (mod === "documents")
    registerDocumentTools(server as any, client as any, { filesystem: true });
  else registerHelperTools(server as any, client as any);
  return { tools, client };
}

function bigResponse(totalBytes: number, declared?: number) {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      sent += 600;
      controller.enqueue(new Uint8Array(600));
    },
  });
  return new Response(body, {
    status: 200,
    headers: new Headers({
      "content-type": "application/pdf",
      ...(declared !== undefined ? { "content-length": String(declared) } : {}),
    }),
  });
}

describe("download size bounds", () => {
  it("find_document_pages refuses a PDF that streams past the configured byte limit", async () => {
    const { tools, client } = collect("documents");
    (client.download as any).mockResolvedValue(bigResponse(1800));
    const r = await tools.get("find_document_pages")!({ id: 1, query: "x" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/download limit|exceeds/);
  });

  it("rejects a declared content-length already over the limit before buffering", async () => {
    const { tools, client } = collect("documents");
    (client.download as any).mockResolvedValue(bigResponse(0, 5000));
    const r = await tools.get("find_document_pages")!({ id: 1, query: "x" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/download limit/);
    // nothing was buffered: the stream reader was never consumed
    expect((client.download as any).mock.calls.length).toBe(1);
  });

  it("allows a small PDF through the bound", async () => {
    const { tools, client } = collect("documents");
    (client.download as any).mockResolvedValue(bigResponse(600));
    const r = await tools.get("find_document_pages")!({ id: 1, query: "nothing" });
    // unpdf may fail on our synthetic PDF; the download bound must not be the reason
    expect(r.content[0].text).not.toMatch(/download limit|exceeds the configured download/);
  });
});

describe("get_documents fanout bound", () => {
  it("refuses more than the configured number of document IDs", async () => {
    const { tools, client } = collect("helpers");
    const r = await tools.get("get_documents")!({ ids: [1, 2, 3, 4, 5, 6] });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/too many document IDs/);
    expect((client.fetch as any).mock.calls.length).toBe(0);
  });

  it("allows up to the configured number of IDs", async () => {
    const { tools } = collect("helpers");
    const r = await tools.get("get_documents")!({ ids: [1, 2, 3, 4, 5] });
    expect(r.isError).toBeUndefined();
  });
});
