# omp-openviking

OpenViking long-term memory and context takeover, as an oh-my-pi (OMP) extension.

## 1. What it is

This is a patch-based fork of the upstream pi coding agent extension example from
`volcengine/OpenViking`, pinned at `v0.4.20` (`b54001e2e5c974ffd7a09ba543813fa104a99561`),
with the vendored tree in `upstream/` and every OMP-specific change expressed as a file
in `patches/`. The one behavioral fix is factory-time tool registration: upstream calls
`registerTools()` inside `start()`, which runs after an async health check in a
fire-and-forget `session_start` handler, so OMP has already assembled the turn's tool
set and none of the tools are offered; `adapters/tool-registration.ts` registers the
same tools synchronously at extension-factory time and wraps every `execute` with a
connectivity guard that returns an error until the server is reachable. It adds seven
`viking_*` tools: `viking_search`, `viking_read`, `viking_browse`, `viking_remember`,
`viking_forget`, `viking_add_resource`, and `viking_archive_expand`.

## 2. Requirements

- A running `openviking-server`. The extension default endpoint is
  `http://127.0.0.1:1933` (the upstream quickstart serves on port `1933`); point
  `OPENVIKING_URL` at a remote server if you use one. Local mode runs without
  authentication.
- An embedding provider, configured server-side, for semantic recall.
- A VLM provider, configured server-side, if you want multimodal ingest (images and
  screenshots captured from turns).

Privacy, stated plainly: a fully local setup (a local GGUF embedding model plus a local
LLM) is the only configuration that keeps captured content on the machine. The cloud
defaults send captured conversation turns off-box, to whatever providers the server is
configured with.

## 3. Install

Pick one of three discovery paths.

Clone into the shared agent extensions directory:

```bash
git clone https://github.com/<owner>/omp-openviking ~/.omp/agent/extensions/openviking
```

Or add the path to `extensions:` in `~/.omp/agent/config.yml`:

```yaml
extensions:
  - ~/.omp/agent/extensions/openviking
```

Or, for a single project, copy or clone the repo into `<cwd>/.omp/extensions/openviking`.

In all three cases the directory resolves as an installed plugin because `package.json`
declares `omp.extensions: ["index.ts"]`, so OMP loads `index.ts` at the repo root
(`index.ts` re-exports the upstream extension factory). No build step; OMP loads the
TypeScript directly.

## 4. Configuration

Defaults live in `upstream/config.json`, which you can edit; every key from that file:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master enable for the extension |
| `syncTurns` | `true` | Auto-capture conversation turns after each turn |
| `recallTokenBudget` | `2000` | Token budget for inline recall content |
| `recallMaxContentChars` | `500` | Per-item content cap for search results |
| `recallPreferAbstract` | `true` | Prefer the L0 abstract over the L2 full body |
| `scoreThreshold` | `0.35` | Minimum relevance score, 0 to 1 |
| `minQueryLength` | `3` | Skip recall for queries shorter than N characters |
| `profileTokenBudget` | `10000` | Token budget for profile injection |
| `resumeContextBudget` | `32000` | Token budget for session resume context |
| `commitTokenThreshold` | `20000` | Token count that triggers a takeover commit |
| `commitKeepRecentCount` | `10` | Recent turns to keep verbatim at commit |
| `takeover.enabled` | `true` | Enable the context takeover subsystem |
| `takeover.tokenThreshold` | `30000` | Token count that triggers a takeover |
| `takeover.keepRecentTurns` | `3` | Recent turns to keep verbatim during takeover |
| `takeover.overviewBudget` | `3000` | Token budget for the archive overview |
| `takeover.overviewPollMs` | `2000` | Poll interval for overview readiness, ms |
| `takeover.overviewPollMax` | `15` | Max poll attempts for overview readiness |
| `captureToolResults` | `false` | Also capture tool-result content |
| `captureMode` | `"semantic"` | Capture strategy: `"semantic"` or `"keyword"` |
| `captureMaxLength` | `24000` | Max characters captured per turn |
| `captureToolMaxChars` | `1000000` | Max characters captured per tool result |
| `captureAssistantTurns` | `true` | Capture assistant turns, not only user turns |
| `bypassPatterns` | `[]` | Glob cwd patterns where OpenViking operations are skipped |
| `logLevel` | `"error"` | Log verbosity: `"silent"`, `"error"`, `"info"` |

The connection itself (endpoint, apiKey, account, user, peerId) is not set in
`config.json`; it is resolved from `OPENVIKING_*` environment variables, then
`~/.openviking/ovcli.conf`, then `~/.openviking/ov.conf`. Every `OPENVIKING_*` variable
the extension reads:

| Environment variable | Overrides |
|---|---|
| `OPENVIKING_URL` | Server base URL; alias `OPENVIKING_BASE_URL` is also read |
| `OPENVIKING_API_KEY` | Bearer apiKey; alias `OPENVIKING_BEARER_TOKEN` is also read |
| `OPENVIKING_MCP_URL` | Explicit MCP endpoint (default is `<baseUrl>/mcp`) |
| `OPENVIKING_ACCOUNT` | Account id for trusted mode |
| `OPENVIKING_USER` | User id for trusted mode |
| `OPENVIKING_PEER_ID` | Peer id override |
| `OPENVIKING_WORKSPACE_PEER` | Workspace peer flag (`1/true/yes/on`, `0/false/no/off`) |
| `OPENVIKING_RECALL_PEER_SCOPE` | Recall scope: `"actor"` or `"all"` |
| `OPENVIKING_RECALL_LIMIT` | Recall result count, clamped 1 to 50 |
| `OPENVIKING_RECALL_QUERY_EXPANSION` | `"off"` or `"auto"` |
| `OPENVIKING_RECALL_LEDGER` | Recall ledger on/off flag |
| `OPENVIKING_RECALL_LEDGER_DIR` | Recall ledger directory |
| `OPENVIKING_DEBUG_LOG` | Debug log file path; `OV_DEBUG_LOG` is a deprecated alias |
| `OPENVIKING_CREDENTIAL_SOURCE` | Credential mode: `"env"`, `"cli"`, or `"auto"` (alias `OPENVIKING_CREDENTIALS_SOURCE`) |
| `OPENVIKING_CLI_CONFIG_FILE` | Path to `ovcli.conf` |
| `OPENVIKING_CONFIG_FILE` | Path to legacy `ov.conf` |
| `OPENVIKING_STATE_DIR` | State file directory |
| `OPENVIKING_HOME` | Home override for the state directory |
| `OPENVIKING_PENDING_DIR` | Offline pending-queue directory |
| `OPENVIKING_PENDING_MAX_RETRIES` | Max retries per pending operation |
| `OPENVIKING_PENDING_TTL_DAYS` | Pending entry TTL in days |
| `OPENVIKING_PENDING_REPLAY_LIMIT` | Pending replay batch cap per session start |
| `OPENVIKING_PENDING_DRAIN_BUDGET_MS` | Sync drain wall-time budget, ms |
| `OPENVIKING_PENDING_DRAIN_MAX_BATCHES` | Sync drain batch cap |

Caveat for `OPENVIKING_DEBUG_LOG`: on Windows it needs a native path such as
`C:\Users\you\ov.log`, not an MSYS style `/c/Users/...` path, or the log file is not
written where you expect. (The vendored e2e probe also reads `OV_E2E_OUT` and
`OV_E2E_TURN`; those only matter for upstream's live-server test scripts.)

## 5. Use OpenViking as the only memory system

OMP ships its own memory backends. To make OpenViking the sole memory system, turn the
OMP backend off in `~/.omp/agent/config.yml`:

```yaml
memory:
  backend: off

extensions:
  - ~/.omp/agent/extensions/openviking
```

Do not run an OMP memory backend (`local`, `hindsight`, `mnemopi`, `sharpshooter`)
alongside this extension: you would get two injected memory blocks in every system
prompt (OMP's "Memory Guidance" block and the extension's `<openviking-context>` block)
and you would pay for turn extraction twice.

## 6. Known gaps

- An extension cannot own `/memory` subcommands: built-in command names are reserved and
  a colliding extension command is skipped, so `/viking` stands alone rather than
  nesting under `/memory`.
- An extension cannot own the `memory://` protocol: OMP exposes no host registration
  API for it, and the handler is host-internal.
- An extension cannot hook auto-retain cadences or subagent memory aliasing, so
  subagents do not share the parent's recall scope.
- `/viking` command output and a real takeover commit at the 30000-token threshold are
  untested against a live server, because the test harness (`test/smoke.mjs`) talks to
  `test/stub-server.mjs`, a stub.

## 7. Maintenance

`upstream/` is never hand-edited; it is re-vendored by `scripts/sync-upstream.mjs`.
Re-sync at a new upstream tag, branch, or SHA with:

```bash
bun run sync -- v0.4.21
```

Running the script with no argument is a drift check: it re-downloads the recorded ref
from `upstream/UPSTREAM.json`, compares it against the vendored tree, and reports the
diff before reapplying patches. Each patch is a file named `NNNN-<slug>.patch`, applied
in lexicographic order with `git apply -p1`. If a patch is rejected (upstream moved the
code it touches), the script prints the captured `git apply` stderr, exits non-zero,
and leaves the freshly vendored tree in place for a human to resolve: rework the patch
or drop it. Once upstream absorbs a patch's change, delete the patch file so the
vendored tree stays byte-identical to upstream plus only the still-needed deltas. The
full convention is documented in `patches/README.md`. The scheduled workflow
`.github/workflows/upstream-check.yml` re-runs the sync and opens a tracking issue when
the upstream subpath moves.

## 8. License and attribution

Apache-2.0, inherited from the upstream `examples/LICENSE`. The upstream repository
root is AGPLv3, but nothing outside `examples/pi-coding-agent-extension` is copied or
imported, so nothing in this fork is AGPL. See `LICENSE` and `NOTICE`.
