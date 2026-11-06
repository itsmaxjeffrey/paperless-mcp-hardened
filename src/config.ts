import path from "node:path";
import { PaperlessClient } from "./paperless/client.js";

const baseUrl = (process.env.PAPERLESS_URL || "").replace(/\/+$/, "");
const adminToken = process.env.PAPERLESS_TOKEN || "";

if (!baseUrl || !adminToken) {
  console.error("PAPERLESS_URL and PAPERLESS_TOKEN environment variables are required");
  process.exit(1);
}

function csv(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function apiVersionFrom(value: string | undefined): string {
  const raw = (value ?? "9").trim();
  return /^(none|off|auto)$/i.test(raw) ? "" : raw;
}

const apiVersion = apiVersionFrom(process.env.PAPERLESS_API_VERSION);

export const TOOLSETS = [
  "core",
  "workflow",
  "helpers",
  "users",
  "automation",
  "documents",
  "mail",
  "sharing",
  "system",
  "search",
] as const;
export type Toolset = (typeof TOOLSETS)[number];

function toolsetsFrom(value: string | undefined): Toolset[] {
  const names = csv(value).map((s) => s.toLowerCase());
  if (names.length === 0) return [...TOOLSETS];
  const unknown = names.filter((n) => !(TOOLSETS as readonly string[]).includes(n));
  if (unknown.length > 0) {
    console.error(
      `Unknown PAPERLESS_TOOLSETS: ${unknown.join(", ")}. Valid toolsets: ${TOOLSETS.join(", ")}`,
    );
    process.exit(1);
  }
  return names as Toolset[];
}

function nonNegativeInt(value: string | undefined, fallback: number): number {
  const raw = (value ?? "").trim();
  if (!/^\d+$/.test(raw)) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const timeoutMs = nonNegativeInt(process.env.PAPERLESS_TIMEOUT_MS, 60000);

const clientOptions = {
  timeoutMs: timeoutMs > 2147483647 ? 60000 : timeoutMs,
  maxRetries: Math.min(nonNegativeInt(process.env.PAPERLESS_MAX_RETRIES, 2), 10),
};

function positiveInt(value: string | undefined, fallback: number, max = 2147483647): number {
  const raw = (value ?? "").trim();
  if (!/^\d+$/.test(raw)) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > max) return fallback;
  return n;
}

const maxSessions = positiveInt(process.env.MCP_MAX_SESSIONS, 100, 10000);

export const config = {
  baseUrl,
  adminToken,
  apiVersion,
  transport: (process.env.MCP_TRANSPORT === "http" ? "http" : "stdio") as "http" | "stdio",
  port: parseInt(process.env.PORT || "3001", 10),
  embeddingsEnabled: /^(1|true|yes)$/i.test(process.env.EMBEDDINGS_ENABLED || ""),
  allowedOrigins: csv(process.env.MCP_ALLOWED_ORIGINS),
  allowedHosts: csv(process.env.MCP_ALLOWED_HOSTS),
  oauthEnabled: Boolean((process.env.MCP_OAUTH_ISSUER || "").trim()),
  toolsets: toolsetsFrom(process.env.PAPERLESS_TOOLSETS),
  readOnly: /^(1|true|yes)$/i.test(process.env.PAPERLESS_READ_ONLY || ""),
  disabledTools: csv(process.env.PAPERLESS_DISABLED_TOOLS),
  fsRoots: csv(process.env.PAPERLESS_FS_ROOTS).map((r) => path.resolve(r)),
  fsMaxReadBytes: positiveInt(process.env.PAPERLESS_FS_MAX_READ_BYTES, 52428800),
  httpHost: (process.env.MCP_HTTP_HOST || "127.0.0.1").trim(),
  maxBodyBytes: positiveInt(process.env.MCP_MAX_BODY_BYTES, 2097152),
  bodyTimeoutMs: positiveInt(process.env.MCP_BODY_TIMEOUT_MS, 30000),
  maxSessions,
  maxSessionsPerCredential: positiveInt(
    process.env.MCP_MAX_SESSIONS_PER_CREDENTIAL,
    10,
    maxSessions,
  ),
  maxInFlightInit: positiveInt(process.env.MCP_MAX_CONCURRENT_INIT, 10, 1000),
  maxInFlightAuth: positiveInt(process.env.MCP_MAX_CONCURRENT_AUTH, 20, 1000),
  authTimeoutMs: positiveInt(process.env.MCP_AUTH_TIMEOUT_MS, 15000),
  sessionIdleMs: positiveInt(process.env.MCP_SESSION_IDLE_MS, 1800000, 2147483647),
  maxDownloadBytes: positiveInt(process.env.MCP_MAX_DOWNLOAD_BYTES, 104857600, 2147483647),
  downloadTimeoutMs: positiveInt(process.env.MCP_DOWNLOAD_TIMEOUT_MS, 30000),
  maxIdsPerRequest: positiveInt(process.env.MCP_MAX_IDS_PER_REQUEST, 100, 1000),
  maxSearchResults: positiveInt(process.env.MCP_MAX_SEARCH_RESULTS, 100, 1000),
};

if (config.transport === "http" && config.fsRoots.length > 0) {
  console.error(
    "PAPERLESS_FS_ROOTS is ignored in http transport: filesystem tools are disabled there",
  );
}

if (
  process.env.PAPERLESS_TOOLSETS &&
  config.toolsets.includes("search") &&
  !config.embeddingsEnabled
) {
  console.error(
    "PAPERLESS_TOOLSETS includes search, but search tools need EMBEDDINGS_ENABLED=true",
  );
}

export const adminClient = new PaperlessClient(baseUrl, adminToken, apiVersion, clientOptions);

const clientCache = new Map<string, PaperlessClient>();
const MAX_CACHE = 100;

export function clientFor(token: string): PaperlessClient {
  if (token === adminToken) return adminClient;
  const existing = clientCache.get(token);
  if (existing) {
    clientCache.delete(token);
    clientCache.set(token, existing);
    return existing;
  }
  const client = new PaperlessClient(baseUrl, token, apiVersion, clientOptions);
  if (clientCache.size >= MAX_CACHE) {
    const oldest = clientCache.keys().next().value;
    if (oldest !== undefined) clientCache.delete(oldest);
  }
  clientCache.set(token, client);
  return client;
}
