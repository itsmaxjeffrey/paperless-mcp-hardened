import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config, clientFor } from "./config.js";
import { PaperlessClient } from "./paperless/client.js";
import { createServer } from "./server.js";
import type { Credential, OAuth } from "./oauth.js";

type Headers = Record<string, string | string[] | undefined>;

export function extractToken(headers: Headers): string | null {
  const auth = headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const t = auth.slice("Bearer ".length).trim();
    if (t) return t;
  }
  const x = headers["x-paperless-token"];
  if (typeof x === "string" && x.trim()) return x.trim();
  return null;
}

export function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // non-browser clients don't send Origin
  return config.allowedOrigins.includes("*") || config.allowedOrigins.includes(origin);
}

export function hostAllowed(host: string | undefined): boolean {
  if (config.allowedHosts.length === 0) return true; // host validation disabled
  if (!host) return false;
  return config.allowedHosts.includes(host) || config.allowedHosts.includes(host.split(":")[0]);
}

export function sessionTokenMatches(expected: string, actual: string | null): boolean {
  if (!actual) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

function plainCredential(headers: Headers): Credential | null {
  const token = extractToken(headers);
  return token ? { key: token, token, oauth: false } : null;
}

function setCors(res: ServerResponse, origin: string | undefined, oauth: boolean) {
  if (config.allowedOrigins.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && config.allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Paperless-Token, mcp-session-id",
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    oauth ? "mcp-session-id, WWW-Authenticate" : "mcp-session-id",
  );
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

class BodyTimeout extends Error {}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BodyTimeout()), config.bodyTimeoutMs);
    timer.unref?.();
  });
  try {
    const collected = (async () => {
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > config.maxBodyBytes) throw new HttpError(413, "Request body too large");
        chunks.push(c as Buffer);
      }
      if (chunks.length === 0) return undefined;
      try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new HttpError(400, "Request body is not valid JSON");
      }
    })();
    return await Promise.race([collected, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  key: string;
  lastSeen: number;
}

function createSessionStore() {
  const sessions = new Map<string, SessionEntry>();
  function sweep(now: number = Date.now()): number {
    let removed = 0;
    for (const [sid, entry] of sessions) {
      if (now - entry.lastSeen > config.sessionIdleMs) {
        sessions.delete(sid);
        removed++;
        entry.transport.close().catch(() => {});
      }
    }
    return removed;
  }
  return { sessions, sweep };
}

const validationClients = new Map<string, PaperlessClient>();
function validationClientFor(token: string): PaperlessClient {
  const existing = validationClients.get(token);
  if (existing) return existing;
  const client = new PaperlessClient(config.baseUrl, token, config.apiVersion, {
    timeoutMs: config.authTimeoutMs,
    maxRetries: 0,
  });
  if (validationClients.size >= 500) {
    const oldest = validationClients.keys().next().value;
    if (oldest !== undefined) validationClients.delete(oldest);
  }
  validationClients.set(token, client);
  return client;
}

async function paperlessTokenValid(token: string): Promise<boolean> {
  try {
    await validationClientFor(token).fetch("/api/profile/");
    return true;
  } catch {
    return false;
  }
}

function jsonError(res: ServerResponse, status: number, error: string) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error }));
}

export function createHttpHandler(oauth: OAuth | null = null) {
  const { sessions, sweep } = createSessionStore();
  let authInFlight = 0;
  let pendingInits = 0;
  const pendingByCred = new Map<string, number>();

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const origin = req.headers.origin;
    setCors(res, origin, Boolean(oauth));
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    if (!hostAllowed(req.headers.host)) {
      jsonError(res, 403, "Host not allowed");
      return;
    }
    if (!originAllowed(origin) && !oauth?.consentOrigin(req)) {
      jsonError(res, 403, "Origin not allowed");
      return;
    }

    const url = new URL(req.url || "/", `http://localhost:${config.port}`);

    try {
      if (oauth && (await oauth.handle(req, res, url))) return;

      if (url.pathname !== "/mcp") {
        res.writeHead(404).end();
        return;
      }

      const credential = oauth ? oauth.resolve(req.headers) : plainCredential(req.headers);
      if (oauth && !credential) {
        oauth.challenge(res, req.headers);
        return;
      }
      if (!credential) {
        jsonError(res, 401, "Missing Paperless token (Authorization: Bearer <token>)");
        return;
      }

      // Admission control: a bounded auth slot is reserved BEFORE any upstream
      // await, so the number of outstanding Paperless validations stays capped.
      if (authInFlight >= config.maxInFlightAuth) {
        jsonError(res, 429, "Too many concurrent authentication requests");
        return;
      }
      authInFlight++;
      let valid: boolean;
      try {
        valid = await paperlessTokenValid(credential.token);
      } finally {
        authInFlight--;
      }
      if (!valid) {
        if (oauth && credential.oauth) oauth.challenge(res, req.headers);
        else jsonError(res, 401, "Paperless token is invalid or revoked");
        return;
      }

      const rawSessionId = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;

      if (sessionId) {
        sweep();
        const existing = sessions.get(sessionId);
        if (!existing || !sessionTokenMatches(existing.key, credential.key)) {
          // Unknown/expired session — let the client re-initialize.
          jsonError(res, 404, "Unknown or expired session");
          return;
        }
        existing.lastSeen = Date.now();
        const body = await readBody(req);
        await existing.transport.handleRequest(req, res, body);
        return;
      }

      // No session id => initialize request. Session limits account for pending
      // initializations atomically: capacity is reserved before any await.
      sweep();
      const pendingForCred = pendingByCred.get(credential.key) ?? 0;
      let sessionsForCred = 0;
      for (const s of sessions.values()) if (s.key === credential.key) sessionsForCred++;
      if (
        sessions.size + pendingInits >= config.maxSessions ||
        sessionsForCred + pendingForCred >= config.maxSessionsPerCredential ||
        pendingInits >= config.maxInFlightInit ||
        authInFlight >= config.maxInFlightAuth
      ) {
        jsonError(res, 429, "Too many sessions");
        return;
      }
      pendingInits++;
      pendingByCred.set(credential.key, pendingForCred + 1);
      try {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            sessions.set(sid, { transport, key: credential.key, lastSeen: Date.now() });
          },
          onsessionclosed: (sid: string) => {
            sessions.delete(sid);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };

        const client = clientFor(credential.token);
        if (oauth && credential.oauth) {
          client.onUnauthorized = () => oauth.revokePaperlessToken(credential.token);
        }
        const server = await createServer(client, { filesystem: false });

        const body = await readBody(req);
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } finally {
        pendingInits--;
        const n = (pendingByCred.get(credential.key) ?? 1) - 1;
        if (n <= 0) pendingByCred.delete(credential.key);
        else pendingByCred.set(credential.key, n);
      }
    } catch (e) {
      if (e instanceof BodyTimeout) {
        if (!res.headersSent) jsonError(res, 408, "Request body timed out");
        req.destroy();
        return;
      }
      const status = e instanceof HttpError ? e.statusCode : 500;
      if (!res.headersSent)
        jsonError(res, status, e instanceof HttpError ? e.message : "Internal server error");
      else res.destroy();
      if (status === 413 || status === 400) req.destroy();
    }
  };

  return Object.assign(handler, {
    sessionStore: { sessions, sweep },
    stats: {
      // Alias kept for consumers of the pre-fix shape: pendingInits is the
      // only outstanding-init counter now.
      get initInFlight() {
        return pendingInits;
      },
      get authInFlight() {
        return authInFlight;
      },
      get pendingInits() {
        return pendingInits;
      },
    },
  });
}

function flushOnShutdown(flush: () => void) {
  process.on("exit", flush);
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => {
      flush();
      process.kill(process.pid, signal);
    });
}

export async function startHttpServer(): Promise<void> {
  let oauth: OAuth | null = null;
  if (config.oauthEnabled) {
    const { createOAuth, oauthSettingsFromEnv, DEFAULT_LIMITS } = await import("./oauth.js");
    const { stateStoreFromEnv } = await import("./oauth-state.js");
    try {
      const settings = oauthSettingsFromEnv();
      const store = stateStoreFromEnv();
      oauth = createOAuth(settings, config.baseUrl, DEFAULT_LIMITS, store);
      if (store) flushOnShutdown(oauth.flush);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  }

  const handler = createHttpHandler(oauth);
  const sweeper = setInterval(() => handler.sessionStore.sweep(), 60000);
  sweeper.unref();

  const httpServer = createHttpServer(handler);
  httpServer.listen(config.port, config.httpHost, () => {
    console.error(
      `paperless-mcp HTTP server listening on ${config.httpHost}:${config.port}/mcp${oauth ? " (OAuth enabled)" : ""}`,
    );
  });
}
