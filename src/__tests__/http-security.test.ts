import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer as createNodeServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

vi.stubEnv("PAPERLESS_URL", "https://p.example.com");
vi.stubEnv("PAPERLESS_TOKEN", "admin-tok");
vi.stubEnv("MCP_MAX_SESSIONS_PER_CREDENTIAL", "2");
vi.stubEnv("MCP_MAX_SESSIONS", "4");
vi.stubEnv("MCP_MAX_CONCURRENT_INIT", "3");
vi.stubEnv("MCP_MAX_CONCURRENT_AUTH", "3");

const { profileState, initState } = vi.hoisted(() => ({
  profileState: {
    failFor: new Set<string>(),
    // token -> resolve callbacks for in-flight validations
    gates: new Map<string, (() => void)[]>(),
    curAuth: 0,
    maxAuth: 0,
    waitUntil: null as number | null,
    onReached: null as (() => void) | null,
    releaseAll() {
      for (const [tok, arr] of this.gates) {
        while (arr.length) arr.shift()!();
        this.gates.delete(tok);
      }
    },
    reset() {
      this.failFor.clear();
      this.releaseAll();
      this.curAuth = 0;
      this.maxAuth = 0;
      this.waitUntil = null;
      this.onReached = null;
    },
  },
  initState: {
    hold: false,
    fail: false,
    gates: [] as (() => void)[],
    cur: 0,
    max: 0,
    waitUntil: null as number | null,
    onReached: null as (() => void) | null,
    releaseAll() {
      while (this.gates.length) this.gates.shift()!();
    },
    reset() {
      this.hold = false;
      this.fail = false;
      this.releaseAll();
      this.cur = 0;
      this.max = 0;
      this.waitUntil = null;
      this.onReached = null;
    },
  },
}));

vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => {
  let seq = 0;
  class FakeTransport {
    opts: Record<string, unknown>;
    sessionId: string | null = null;
    onclose: (() => void) | undefined;
    constructor(opts: Record<string, unknown> = {}) {
      this.opts = opts;
    }
    async handleRequest(_req: unknown, res: import("node:http").ServerResponse, body: unknown) {
      const init = this.opts as {
        onsessioninitialized?: (sid: string) => void;
        onsessionclosed?: (sid: string) => void;
      };
      if (!this.sessionId && init.onsessioninitialized) {
        this.sessionId = `sid-${seq++}`;
        init.onsessioninitialized(this.sessionId);
      }
      res.writeHead(200, {
        "content-type": "application/json",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      });
      res.end(JSON.stringify({ handled: body }));
    }
    async close() {
      const init = this.opts as { onsessionclosed?: (sid: string) => void };
      if (this.sessionId && init.onsessionclosed) init.onsessionclosed(this.sessionId);
      this.onclose?.();
    }
  }
  return { StreamableHTTPServerTransport: FakeTransport };
});

vi.mock("../paperless/client.js", () => {
  class PaperlessClient {
    constructor(
      public baseUrl: string,
      public token: string,
    ) {}
    async fetch(path: string) {
      if (path === "/api/profile/") {
        if (profileState.failFor.has(this.token)) throw new Error("401: invalid token credentials");
        profileState.curAuth++;
        profileState.maxAuth = Math.max(profileState.maxAuth, profileState.curAuth);
        if (
          profileState.waitUntil !== null &&
          profileState.curAuth >= profileState.waitUntil &&
          profileState.onReached
        ) {
          const cb = profileState.onReached;
          profileState.onReached = null;
          cb();
        }
        try {
          if (profileState.gates.has(this.token)) {
            await new Promise<void>((r) => profileState.gates.get(this.token)!.push(r));
          }
        } finally {
          profileState.curAuth--;
        }
        return { username: "mock" };
      }
      return {};
    }
  }
  return { PaperlessClient };
});

vi.mock("../server.js", () => ({
  createServer: vi.fn(async () => {
    initState.cur++;
    initState.max = Math.max(initState.max, initState.cur);
    try {
      if (initState.fail) throw new Error("createServer failed");
      if (initState.hold) {
        if (
          initState.waitUntil !== null &&
          initState.cur >= initState.waitUntil &&
          initState.onReached
        ) {
          const cb = initState.onReached;
          initState.onReached = null;
          cb();
        }
        await new Promise<void>((r) => initState.gates.push(r));
      }
    } finally {
      initState.cur--;
    }
    return {
      connect: vi.fn(),
    };
  }),
  checkToolSelection: vi.fn(),
}));

const { createHttpHandler } = await import("../http.js");

const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t", version: "1" },
  },
});
const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

describe("HTTP hardening", () => {
  let server: Server;
  let base: string;
  let handler: ReturnType<typeof createHttpHandler>;

  // Every test gets a fresh handler and a fully closed lifecycle so session
  // caps from one test never leak into the next.
  beforeEach(async () => {
    profileState.reset();
    initState.reset();
    handler = createHttpHandler();
    server = createNodeServer(handler);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    profileState.releaseAll();
    profileState.reset();
    initState.hold = false;
    initState.releaseAll();
    initState.reset();
    for (const [, s] of handler.sessionStore.sessions) await s.transport.close();
    await new Promise<void>((r) => server.close(() => r()));
    server.closeAllConnections();
  });

  const init = (token: string, body = INIT) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...HEADERS, Authorization: `Bearer ${token}` },
      body,
    });

  it("rejects initialization when Paperless does not validate the token", async () => {
    profileState.failFor.add("invalid-tok");
    const r = await init("invalid-tok");
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: "Paperless token is invalid or revoked" });
  });

  it("initializes a session after Paperless validates the token", async () => {
    const r = await init("valid-tok");
    expect(r.status).toBe(200);
    expect(r.headers.get("mcp-session-id")).toMatch(/^sid-/);
    await r.text();
  });

  it("revalidates the token on every request to an existing session", async () => {
    const r = await init("revoked-later");
    const sid = r.headers.get("mcp-session-id")!;
    await r.text();
    expect(sid).toBeTruthy();
    profileState.failFor.add("revoked-later");
    const second = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...HEADERS, Authorization: "Bearer revoked-later", "mcp-session-id": sid },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
    });
    expect(second.status).toBe(401);
    await second.text();
  });

  it("rejects oversized bodies with 413", async () => {
    const big = "x".repeat(3 * 1024 * 1024);
    const r = await init("valid-tok", JSON.stringify({ pad: big }));
    expect(r.status).toBe(413);
    await r.text();
  });

  it("rejects malformed JSON with 400", async () => {
    const r = await init("valid-tok", "{not json");
    expect(r.status).toBe(400);
    await r.text();
  });

  it("caps sessions per credential for repeated identical credentials", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await init("same-cred-tok");
      statuses.push(r.status);
      await r.text();
    }
    // Global cap (4) is above the per-credential cap (2): exactly the
    // per-credential limit is what stops this credential.
    expect(statuses).toEqual([200, 200, 429, 429]);
  });

  it("caps sessions globally using distinct credentials", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await init(`global-tok-${i}`);
      statuses.push(r.status);
      await r.text();
    }
    expect(statuses).toEqual([200, 200, 200, 200, 429]);
  });

  it("counts pending initializations against session limits atomically", async () => {
    // Pre-fill three sessions so only one more fits under the global cap of 4.
    for (let i = 0; i < 3; i++) {
      const r = await init(`prefill-${i}`);
      expect(r.status).toBe(200);
      await r.text();
    }
    // Gate the profile validation of all five contenders, then release them at
    // once: the session cap decision must include pending inits, or several
    // would slip past the check before any session registers.
    profileState.gates.set("racer", []);
    profileState.waitUntil = 3;
    const gateReached = new Promise<void>((r) => (profileState.onReached = r));
    const races = Array.from({ length: 5 }, () => init("racer"));
    await gateReached;
    profileState.releaseAll();
    const results = await Promise.all(races);
    const statuses = results.map((r) => r.status);
    for (const r of results) await r.text();
    expect(statuses.filter((s) => s === 200).length).toBe(1);
    expect(statuses.filter((s) => s === 429).length).toBe(4);
  });

  it("bounds outstanding auth/init work and refuses excess admission while validations are held open", async () => {
    const tokens = ["hold-a", "hold-b", "hold-c"];
    for (const t of tokens) profileState.gates.set(t, []);
    profileState.waitUntil = 3;
    const gateReached = new Promise<void>((r) => (profileState.onReached = r));
    const held = tokens.map((t) => init(t));
    await gateReached;
    // Deterministically three validations are outstanding now.
    expect(profileState.curAuth).toBe(3);
    expect(handler.stats.authInFlight).toBe(3);
    expect(handler.stats.pendingInits).toBeLessThanOrEqual(3);
    // A request arriving while the auth gate is saturated is refused outright
    // instead of piling up as unbounded outstanding auth work.
    const late = await init("late-comer");
    expect(late.status).toBe(429);
    await late.text();
    profileState.releaseAll();
    const results = await Promise.all(held);
    const statuses = results.map((r) => r.status);
    for (const r of results) await r.text();
    expect(profileState.maxAuth).toBe(3);
    expect(statuses).toEqual([200, 200, 200]);
    expect(handler.sessionStore.sessions.size).toBe(3);
  });

  it("keeps the init cap effective after completed initializations", async () => {
    // Complete a first wave FIRST: with the pre-fix initInFlight accounting,
    // each completion drove initInFlight negative, so this wave would never
    // hit the configured cap again.
    for (const t of ["wave-a", "wave-b"]) {
      const r = await init(t);
      expect(r.status).toBe(200);
      await r.text();
    }
    // Close those sessions so global session capacity is not what stops the
    // next wave; only the init cap can be under test.
    for (const [, s] of handler.sessionStore.sessions) await s.transport.close();
    expect(handler.sessionStore.sessions.size).toBe(0);
    expect(handler.stats.pendingInits).toBe(0);
    expect(handler.stats.initInFlight).toBe(0);
    expect(handler.stats.authInFlight).toBe(0);

    // Hold the first three wave requests inside createServer (maxInFlightInit
    // is 3) so the init slots are deterministically occupied.
    initState.hold = true;
    initState.waitUntil = 3;
    const reached = new Promise<void>((r) => (initState.onReached = r));
    const held = ["w1", "w2", "w3"].map((t) => init(t));
    profileState.releaseAll();
    await reached;
    expect(initState.max).toBe(3);
    expect(handler.stats.pendingInits).toBe(3);

    // While those three remain held, excess requests must be refused 429
    // instead of piling up behind the saturated init slots.
    const excess = [init("x1"), init("x2")];
    const excessResults = await Promise.all(excess);
    for (const r of excessResults) {
      expect(r.status).toBe(429);
      await r.text();
    }
    expect(handler.stats.pendingInits).toBe(3);

    // Release the held three: they all succeed and every counter drains to 0.
    initState.releaseAll();
    const results = await Promise.all(held);
    const statuses = results.map((r) => r.status);
    for (const r of results) await r.text();
    expect(statuses).toEqual([200, 200, 200]);
    expect(initState.max).toBe(3);
    expect(handler.stats.pendingInits).toBe(0);
    expect(handler.stats.initInFlight).toBe(0);
    expect(handler.stats.authInFlight).toBe(0);

    // A wave whose createServer fails must also leave every counter at zero.
    for (const [, s] of handler.sessionStore.sessions) await s.transport.close();
    expect(handler.sessionStore.sessions.size).toBe(0);
    initState.fail = true;
    const failures = await Promise.all([init("f1"), init("f2")]);
    for (const r of failures) {
      expect(r.status).toBe(500);
      await r.text();
    }
    expect(handler.stats.pendingInits).toBe(0);
    expect(handler.stats.initInFlight).toBe(0);
    expect(handler.stats.authInFlight).toBe(0);
  });

  it("expires idle sessions", async () => {
    const r = await init("idle-tok");
    const sid = r.headers.get("mcp-session-id")!;
    await r.text();
    const store = handler.sessionStore;
    store.sessions.get(sid)!.lastSeen = Date.now() - 3600_000;
    store.sweep();
    expect(store.sessions.has(sid)).toBe(false);
    const second = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...HEADERS, Authorization: "Bearer idle-tok", "mcp-session-id": sid },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
    });
    expect(second.status).toBe(404);
    await second.text();
  });

  it("rejects session requests that do not match the credential", async () => {
    const r = await init("owner-tok");
    const sid = r.headers.get("mcp-session-id")!;
    await r.text();
    const second = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...HEADERS, Authorization: "Bearer attacker-tok", "mcp-session-id": sid },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
    });
    expect(second.status).toBe(404);
    await second.text();
  });
});
