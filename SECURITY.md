# Security Policy

## Scope

This repository is an independent security-hardening fork of
[OrellBuehler/paperless-mcp](https://github.com/OrellBuehler/paperless-mcp),
based on upstream commit `11710d7c6470058bb8c1a12a0c07e1426d0d1b25` (release
1.6.0). The upstream project remains MIT-licensed and all credit for the
original design and tool catalog belongs to its author. This fork does not make
claims about the security of upstream releases other than the specific issues
listed in [SECURITY-CHANGES.md](SECURITY-CHANGES.md), and it makes no claim that
every possible vulnerability has been eliminated here.

## Supported versions

Only the latest commit of this fork is supported. No binary artifacts are
published; run from a checkout.

## What this fork hardens

Summary (details and prerequisites in [SECURITY-CHANGES.md](SECURITY-CHANGES.md)):

- HTTP-mode credentials are validated against Paperless (`GET /api/profile/`)
  before any MCP operation or session allocation, and revalidated on every
  request, so a revoked token is refused on its next request. Revocation is
  checked per new request, not by canceling in-flight work: a request already
  being processed may finish, and note that a revoked token already lost access
  to upstream Paperless data at the baseline release — what this check closes
  is acceptance of the MCP session and non-upstream tools after revocation. The
  validation
  reserves a bounded concurrent-auth slot (`MCP_MAX_CONCURRENT_AUTH`) before
  any upstream await, so outstanding authentication work is capped even under
  a flood of simultaneous requests; excess requests get 429. OAuth-mapped
  Paperless credentials go through the same check.
- Filesystem-touching tools (`upload_document`, `upload_document_version`,
  `bulk_download_documents`, `extract_document_pages`) are disabled on the HTTP
  transport for all users, and on stdio are restricted to explicitly configured
  canonical roots with symlink-escape prevention, exclusive writes, and bounded
  regular-file reads (opened with `O_NOFOLLOW`, `fstat`ed, and read with a
  max+1 bound so growth mid-read is caught). These checks assume the configured
  roots are trusted-owner directories on the local machine; Node's path checks
  cannot defeat every race a hostile local process can run against the
  filesystem.
- `upload_from_url` was removed: it fetched attacker-named URLs before
  authentication and enforced only a declared Content-Length cap.
- HTTP request bodies are size-capped (413) and time-capped; sessions are
  bounded globally and per credential (429) with pending initializations
  counted atomically against both caps, expire when idle, and concurrent
  initializations and authentications are limited.
- Read-side amplification is bounded: semantic-search result counts, per-request
  document-ID fanout, and buffered document downloads (core text/image/binary
  downloads, thumbnails, PDF page extraction and search, ZIP exports) all have
  configurable maximums (`MCP_MAX_SEARCH_RESULTS`, `MCP_MAX_IDS_PER_REQUEST`,
  `MCP_MAX_DOWNLOAD_BYTES`) and a total body-read deadline
  (`MCP_DOWNLOAD_TIMEOUT_MS`); the declared Content-Length is only an early
  reject, and the streamed byte count is the enforced bound.
- The vector-index data directory is restricted to mode 0700 and `vectors.db`
  to mode 0600 on POSIX systems (existing files included); symlinked or
  non-regular database targets are refused (dangling symlinks included), and a
  symlinked or non-directory data directory is refused before any chmod.
  Windows does not honor POSIX file
  modes; there, protect the directory through filesystem ACLs instead.
- The HTTP server binds to `127.0.0.1` by default; remote binding requires
  explicit `MCP_HTTP_HOST`.
- Tokens are never logged.

## Reporting a vulnerability

Private vulnerability reporting is enabled on this repository. Open a private
security advisory via GitHub's "Report a vulnerability" flow, or contact the
maintainer of this fork directly. Do not open a
public issue with exploit details. Please do not test against Paperless
instances you do not own.

## Limits and guarantees

These fixes address a specific reviewed issue list against the stated baseline
commit. They are mitigations with documented prerequisites and residual risks
(see [SECURITY-CHANGES.md](SECURITY-CHANGES.md)), not a universal security
guarantee. No prebuilt binaries, npm package, container image, or hosted
website is published for this fork; run it from a source checkout or a locally
built container.

## Hardening guidance for operators

- Keep the default localhost bind; use a reverse proxy or container network for
  remote access, and set `MCP_ALLOWED_ORIGINS` / `MCP_ALLOWED_HOSTS` when the
  server is reachable from browsers or on a shared hostname.
- Run the container as non-root (the image already does, with a root-owned
  `/app` and only `/data` writable) with `read_only: true`, bind
  `MCP_HTTP_HOST=0.0.0.0` inside the container, and publish the port only to
  host loopback (`127.0.0.1:3001:3001`) or a private network. No prebuilt fork
  image is advertised; build locally from the included `Dockerfile`.
- Set `PAPERLESS_READ_ONLY=true` or narrow `PAPERLESS_TOOLSETS` if agents only
  need search and retrieval.
- Leave `PAPERLESS_FS_ROOTS` unset unless stdio agents genuinely need local file
  tools, and point it at a dedicated directory tree, not your home directory.
