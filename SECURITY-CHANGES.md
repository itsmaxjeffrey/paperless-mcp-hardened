# Security Changes

This document lists the security issues addressed in this fork, the fixes, the
realistic prerequisites for each issue, what was verified, and what remains.
All changes are against upstream `paperless-mcp` commit
`11710d7c6470058bb8c1a12a0c07e1426d0d1b25` (release 1.6.0). Nothing here should
be read as a claim that every possible vulnerability has been eliminated, that
any issue received a CVE identifier (none did, to this fork's knowledge), or as
criticism of the upstream project, whose work this fork builds on.

## Issue / fix matrix

### 1. Non-OAuth HTTP tokens accepted without Paperless validation

- **Issue.** In HTTP mode, any nonempty bearer string was accepted as a
  credential and bound to an MCP session without checking it against the
  Paperless API. Sessions for such tokens were allocated before any proof that
  the token was real, and a token revoked in Paperless kept its MCP session.
  Prerequisites: network reachability of the MCP HTTP port by an attacker.
- **Fix.** `src/http.ts` now validates the credential against
  `GET /api/profile/` before any MCP operation and revalidates on every request,
  honoring revocation mid-session for plain tokens and for the Paperless tokens
  mapped from OAuth grants. Invalid or revoked tokens get 401. Revalidation
  applies to new requests only: a request already being processed is not
  cancelled mid-flight. Before this fix, a revoked token could keep using its
  MCP session and the MCP server's non-upstream tools, but it never bypassed
  upstream Paperless authorization — every Paperless API call still carried the
  token and failed there once revoked.
- **Admission control.** The validation is reserved a bounded auth slot
  (`MCP_MAX_CONCURRENT_AUTH`, default 20) _before_ any upstream await and
  released in a `finally`; excess requests are refused 429 instead of piling up
  as unbounded outstanding authentication work. The probe uses a dedicated
  client with its own timeout (`MCP_AUTH_TIMEOUT_MS`, default 15 s) and no
  retries, so a slow Paperless cannot stretch validations indefinitely.
- **Tests.** `src/__tests__/http-security.test.ts` (validation on init,
  per-request revalidation, held-open validations bounded with a gate,
  saturated-gate 429); `src/__tests__/oauth.test.ts` updated to mock the
  Paperless profile endpoint, mirroring the new auth flow.

### 2. Unrestricted `readFile` in upload tools

- **Issue.** `upload_document` and `upload_document_version` passed a
  model-supplied `file_path` straight to `readFile`, allowing reads of any file
  the process can open (e.g. `/etc/shadow` if running privileged) and uploads
  into Paperless. Prerequisites: a malicious or prompt-injected MCP client on
  stdio or HTTP, plus an account with upload permission so the exfiltrated file
  is actually ingested into the user's Paperless instance.
- **Fix.** Both tools now read through `src/security/fs.ts`
  (`readFromAllowedPath`): absolute paths only, canonical containment under
  configured roots, symlink escape prevention, regular files only, and a
  bounded read size (`PAPERLESS_FS_MAX_READ_BYTES`, default 50 MB). The tools
  are disabled on HTTP entirely and on stdio only register when
  `PAPERLESS_FS_ROOTS` is configured.
- **Time-of-check hardening.** The read opens the canonical path with
  `O_NOFOLLOW` (rejecting a symlink swapped in as the final component after the
  check), `fstat`s the open handle so the regular-file check and size limit
  apply to the file actually read, reads at most `max + 1` bytes so a file that
  grows during the read is still rejected, and never trusts a pre-read `stat`.
  Writes loop over `handle.write` until every byte is flushed, so a partial
  write can never be reported as success.
- **Trust model.** The configured roots are trusted-owner directories on the
  local machine. Node's path checks cannot defeat every race a hostile local
  process (or a root-level attacker on the same host) can run against the
  filesystem; the bounds assume roots are owned by the same user as the server
  and not writable by untrusted local accounts.
- **Tests.** `src/__tests__/fs-guard.test.ts` (including exact-limit reads,
  over-limit rejection, multi-megabyte write completeness, final-component
  symlink); tool-availability assertions in `src/__tests__/toolsets.test.ts`.

### 3. Unrestricted `writeFile` in output tools

- **Issue.** `bulk_download_documents` and `extract_document_pages` wrote
  attacker-chosen `output_path` values anywhere the process could write,
  including clobbering existing files. Prerequisites: as above.
- **Fix.** Both tools write through `writeToAllowedPath`: containment under
  configured roots via the canonicalized parent directory, and exclusive writes
  (`open(..., "wx")`) that refuse to create through an existing file or symlink
  and never overwrite. Same registration gating as above.
- **Tests.** `src/__tests__/fs-guard.test.ts` (exclusive writes, symlinked
  target, symlinked directory component, missing directory).

### 4. `upload_from_url` fetched arbitrary URLs before authentication

- **Issue.** The tool issued a server-side `fetch` of a caller-supplied URL
  before any auth-gated work, enabling requests against internal services
  (SSRF); the only size cap was the response-declared `Content-Length`, which a
  server can omit or lie about while streaming an unbounded body.
  Prerequisites: access to the tool on any transport.
- **Fix.** The tool was removed entirely (allowed and chosen per the review
  guidance). `src/tools/helpers.ts`, `src/tools/annotations.ts`, and its tests
  were updated; `README.md` and the GitHub Pages catalog no longer list it.
  Users who need URL ingestion should download the file themselves and use
  `upload_document` inside the configured roots.
- **Tests.** `src/__tests__/injection.test.ts` asserts it no longer registers;
  `src/__tests__/toolsets.test.ts` asserts no annotation remains.

### 5. Unbounded HTTP request bodies and session state

- **Issue.** `readBody` buffered the entire request body into memory before any
  size check, and the session map grew without limit; one credential (or an
  anonymous flood of initialize requests, previously) could exhaust memory or
  session slots. Slow bodies could hold handlers indefinitely.
  Prerequisites: network reachability of the HTTP port.
- **Fix.** Bodies are streamed with a hard byte cap (`MCP_MAX_BODY_BYTES`,
  default 2 MB, rejected with 413) and a read timeout (`MCP_BODY_TIMEOUT_MS`,
  default 30 s, 408); malformed JSON gets 400. Sessions are capped globally
  (`MCP_MAX_SESSIONS`, 100) and per credential (`MCP_MAX_SESSIONS_PER_CREDENTIAL`, 10) with 429 responses, expire after idle (`MCP_SESSION_IDLE_MS`, 30 min) via
  a sweeper, and concurrent session initializations are bounded
  (`MCP_MAX_CONCURRENT_INIT`, 10) so slow `createServer` work cannot accumulate.
  Pending initializations count against both the global and per-credential
  session caps atomically: capacity is reserved synchronously before any
  `await`, so delayed validations cannot slip extra sessions past the check.
- **Tests.** `src/__tests__/http-security.test.ts` (413, 400, per-credential
  cap with repeated identical credentials, global cap with distinct
  credentials, atomic pending-init accounting, idle expiry). Each test gets a
  fresh handler and a fully closed lifecycle so caps never leak between tests.
  Wire behavior (invalid token → 401, valid initialize → 200, revoked token →
  401, tool listing without filesystem tools) is covered end-to-end against the
  real MCP SDK transport in `src/__tests__/mcp-wire.test.ts`.

### 6. HTTP listener bound to all interfaces by default

- **Issue.** `httpServer.listen(port)` bound every interface, so starting HTTP
  mode exposed the server on the whole network unless the operator noticed.
  Prerequisites: running HTTP mode without an explicit firewall rule.
- **Fix.** The listener binds `MCP_HTTP_HOST` (default `127.0.0.1`); containers
  and remote deployments must set it explicitly. The `Dockerfile` now runs as
  the non-root `node` user and supports a read-only root filesystem; the README
  documents `read_only: true`, `MCP_HTTP_HOST=0.0.0.0` for containers, and the
  trade-offs in `SECURITY.md`.
- **Tests.** Default-host assertion in `src/__tests__/http-security.test.ts`.

### 7. Dependency advisories

- **Issue.** `npm audit` reported the moderate `minimatch` advisory
  GHSA-g3hv-75wg-m249 (glob-parts amplification, fixed in 11.0.1) in the
  dev-only eslint toolchain via `@eslint/config-array` and
  `@typescript-eslint/typescript-estree` (10 findings, all tracing to one
  `minimatch` 10.2.6). No eslint 10-compatible release carried the fix.
- **Fix.** A package `overrides` entry pins `minimatch@>=7 <11.0.1` to
  `11.0.1` (same Node 18/20/22+ engines, dual CJS/ESM exports; legacy minimatch
  v3 dependents are intentionally not overridden). Remove the override once the
  direct dependents (`eslint`, `typescript-eslint`) declare `minimatch` at a
  fixed version themselves. `npm audit` and `npm audit --omit=dev` now both
  report 0 vulnerabilities; lint, typecheck, build, and the full test suite
  pass on 11.0.1 (verified with a stdin lint smoke test that TS glob matching
  still flags unused variables and accepts valid code).
- **Note.** These advisories were reachable via dependency resolution paths in
  this repository's dependency tree; no claim is made that any of them was
  exploited in practice.

### 8. Publishing workflows

- **Issue (operational).** The publish workflow released the upstream npm
  package name and the Docker workflow could publish under the fork's identity
  without making the fork relationship explicit.
- **Fix.** `.github/workflows/publish.yml` no longer publishes to npm and no
  longer greps for `npm publish` (the check matched its own source and always
  failed). It verifies the build and asserts `package.json` sets `private: true`
  and carries the fork's own identity, so `npm publish` would be refused by npm
  itself. The package is now `@itsmaxjeffrey/paperless-mcp-hardened`
  `1.6.1-hardened.1` with fork repository/homepage/issue metadata; the original
  author, MIT license, and upstream credit are preserved unchanged (`LICENSE`
  untouched). The legacy GitHub Pages publishing workflow is disabled (manual
  dispatch with an explicit confirmation input only). No container image or
  hosted website is advertised until one is verified; README and `site/` were
  rewritten so every install/run instruction builds and runs this fork from a
  source checkout, never the upstream npm package. Docker images, if built by
  the repository workflow, publish under the fork's own GHCR namespace.

## Read-only resource consumption bounds

The server performs no writes outside configured filesystem roots and Paperless
itself, but unrestricted read-side amplification was still possible. These are
now bounded:

- `semantic_search` clamps its result count to `MCP_MAX_SEARCH_RESULTS`
  (default 100) before over-fetching from the vector index.
- `get_documents` refuses more than `MCP_MAX_IDS_PER_REQUEST` (default 100)
  IDs instead of fanning out one fetch per ID without limit.
- Buffered document downloads (thumbnails, bulk-download zips, PDF page
  extraction and text search) stream through a bounded reader: a declared
  `Content-Length` over `MCP_MAX_DOWNLOAD_BYTES` (default 100 MB) is rejected
  before buffering, and a body that streams past the limit mid-flight is
  rejected while streaming, so a lying server cannot exhaust memory.
- All numeric limits are parsed as finite positive integers within sane ranges;
  oversized or malformed env values fall back to the default instead of
  becoming `Infinity`.
- Generic HTTP 500 responses no longer echo raw backend error strings.
- **Tests.** `src/__tests__/resource-limits.test.ts` (streaming-limit rejection
  with a lying body, declared-length rejection, small-file pass-through, ID
  fanout cap).

## Behavior changes for existing users (migration)

- `upload_from_url` is gone. Remove it from any client allowlists or
  `PAPERLESS_DISABLED_TOOLS` entries; the name simply no longer exists.
- HTTP mode: filesystem tools never register; plain-token and OAuth credentials
  are checked against Paperless on every request (one extra API call per
  request), so an unreachable Paperless makes the MCP server unusable until the
  connection recovers — this is intentional.
- stdio mode: `upload_document`, `upload_document_version`,
  `bulk_download_documents`, and `extract_document_pages` only register when
  `PAPERLESS_FS_ROOTS` is set, and file access is restricted to those roots.
  Point `PAPERLESS_FS_ROOTS` at a directory the agent may use.
- HTTP binds to `127.0.0.1` by default; set `MCP_HTTP_HOST` inside containers
  (and publish the port to host loopback or a private network only).
- zod is now v4; if you embed this server as a library, align your zod version.
- New limits (all optional, defaults listed): `MCP_MAX_CONCURRENT_AUTH` (20),
  `MCP_AUTH_TIMEOUT_MS` (15000), `MCP_MAX_DOWNLOAD_BYTES` (100 MB),
  `MCP_MAX_IDS_PER_REQUEST` (100), `MCP_MAX_SEARCH_RESULTS` (100),
  `MCP_DOWNLOAD_TIMEOUT_MS` (30000). Under
  sustained auth saturation requests are refused 429; raise
  `MCP_MAX_CONCURRENT_AUTH` if a busy deployment hits it innocently.
- Private-index permissions: on POSIX systems the vector-index data directory
  (`PAPERLESS_MCP_DATA`, default `~/.paperless-mcp`) is forced to mode 0700 and
  `vectors.db` to mode 0600 (existing files included); symlinked or
  non-regular database targets are refused before SQLite opens (dangling
  symlinks included, detected with `lstat`), and a symlinked or non-directory
  data directory is refused before any mode change, so private-mode chmods
  never follow a directory symlink. Windows does not
  honor POSIX file modes; there, restrict access to the directory through
  filesystem ACLs (e.g. a per-user data directory), which the server cannot set
  portably.

## Validation performed

- `npm test` (all suites, including new `fs-guard`, `http-security`,
  `mcp-wire` (real SDK HTTP integration), `resource-limits`, and updated
  `oauth`, `injection`, `toolsets`, `pdf-tools` tests), `npm run build`,
  `npm run lint`, `npm run format:check`, `npm run typecheck`.
- `npm audit` (full tree) and `npm audit --omit=dev`: 0 vulnerabilities, after
  the `minimatch` override described above.
- Optional native modules (`better-sqlite3`) rebuilt locally
  (`npm rebuild better-sqlite3`) and the sqlite-vec vector-store suite
  (`vectordb.test.ts`, 22 tests) run against the real bindings.

## Validation limitations

- Tests mock the Paperless REST API and the MCP SDK transport; end-to-end
  behavior against a live Paperless-ngx instance was not exercised, and no live
  Paperless instance was contacted while preparing these changes.
- The OAuth sign-in flow against a real identity provider was not exercised.
- Semantic-search (sqlite-vec / better-sqlite3) paths were not benchmarked under
  the new limits.

## Residual risks

- A validated-but-malicious Paperless user can still do whatever their
  Paperless permissions allow (read documents they can see, edit objects they
  own); the server enforces no authorization beyond Paperless itself, by design.
- Per-request token validation adds latency and load to Paperless; the API
  version pinned for that probe is the configured `PAPERLESS_API_VERSION`.
- Local stdio agents with filesystem roots configured can still read (within
  size bounds) and create new files inside those roots; choose roots that hold
  nothing sensitive.
- Body/session caps are denial-of-service _mitigations_, not guarantees; a
  determined client with a valid token can still hold up to
  `MCP_MAX_SESSIONS_PER_CREDENTIAL` sessions and `MCP_MAX_CONCURRENT_INIT`
  initializations.
- A growing file can be caught by the `max + 1` read bound, but a file replaced
  by another same-size file mid-read (by a hostile local account) cannot;
  roots are assumed to be same-owner, non-hostile directories.
- The per-credential session cap counts MCP sessions, not distinct HTTP
  requests; request-level admission is bounded by the auth and init caps.
- The `minimatch` override pins a dev-only transitive version, not a source
  change; if a future eslint/typescript-eslint release resolves it, the pin is
  removed and the advisory can only reappear if the override is deleted while
  vulnerable versions resolve again.
- No prebuilt container image or hosted website is published or advertised for
  this fork; build locally from source.
- No claim is made that every possible vulnerability has been eliminated; these
  are fixes for a specific reviewed issue list, not a general security
  certification.
