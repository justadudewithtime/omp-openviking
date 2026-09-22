# omp-openviking

OpenViking context memory for oh-my-pi, a fork of OpenViking's pi-coding-agent extension.

You get the server's `openviking_*` tools, automatic recall, turn capture and takeover, unchanged
from upstream. For everything about OpenViking itself, read the official docs:

- [Getting started](https://openviking.ai/en/getting-started/) (install and run the server)
- [Configuration](https://openviking.ai/en/configuration/) (every tuning field and env var)
- [Agent integrations: pi](https://openviking.ai/en/agent-integrations/11-pi)

## Install

```sh
git clone --recurse-submodules --shallow-submodules \
  https://github.com/justadudewithtime/omp-openviking.git \
  ~/.omp/agent/extensions/openviking
cd ~/.omp/agent/extensions/openviking && bun run setup
```

`bun run setup` is not optional any more. Upstream stopped committing two things the extension
needs: the `shared/` modules it imports (generated from `examples/memory-plugin-shared/lib`) and
the MCP client package its tools run on. Setup initializes the submodule if you forgot
`--recurse-submodules`, installs the package, generates `shared/`, and applies `patches/`. It is
safe to re-run and never fetches a new upstream commit.

Then tell OMP about it and switch off OMP's own memory backend:

```yaml
# ~/.omp/agent/config.yml
extensions:
  - ~/.omp/agent/extensions/openviking
memory:
  backend: off
```

An active OMP backend would inject its own memory block next to OpenViking's and extract every
turn twice.

## Server

The extension starts `openviking-server` when nothing answers on the endpoint, and stops it again
when the last OMP process using it exits. Concurrent sessions share one server: whoever gets there
first starts it, everyone else adopts it. A server you started yourself is adopted and never
stopped, and neither is anything the extension cannot prove it started.

`OPENVIKING_NO_AUTOSTART=1` only ever adopts, `OPENVIKING_NO_AUTOSTOP=1` leaves the server running
after the last session, and `OPENVIKING_AUTOSTART_TIMEOUT_MS` (default 30000) bounds how long a
start is given to answer. A local server answers in under ten seconds; that wait is paid once, by
whichever session finds the server down, and concurrent sessions wait on the same start.

`OPENVIKING_URL` overrides the default endpoint `http://127.0.0.1:1933`. Everything else is tuned
through the layers upstream resolves: `OPENVIKING_*` environment variables, then
`.openviking/config.json` in the workspace, then `plugin.pi` and `plugin` in `ovcli.conf`, then the
defaults declared in `upstream/examples/memory-plugin-shared/lib/config-schema.mjs`. Nothing is
configured by editing a file inside the submodule any more, so an update never has to preserve your
settings.

## What differs from upstream

Two adapters and one patch.

`adapters/tool-registration.ts` gets the tools onto the first turn. Upstream's tool surface is the
server's MCP catalogue: it connects an MCP client inside an async `session_start` chain and
registers one tool per listed tool, by which time OMP has already assembled the turn's tool set.
This adapter runs that handshake at extension-factory time, which OMP awaits, and registers the
catalogue through upstream's own `registerMcpTools()`, so names, schemas and argument validation
stay upstream's. The host passed on to upstream's factory then drops the duplicate registrations
its own bridge makes later. A session therefore opens two MCP connections, upstream's and this
one; only this one serves calls. A failed handshake falls back to upstream's late registration,
which costs the first turn its tools and nothing else.

`adapters/server-lifecycle.ts` adds the shared server lifecycle described above, which upstream
leaves to you.

`patches/0001-windows-import-file-url.patch` makes upstream's `handshake-once` test import the
extension by `file://` URL, which is the only form Node's ESM loader accepts on Windows.

Host limitations, not bugs: extensions cannot own `/memory` subcommands or the `memory://`
protocol, and subagents do not share the parent's recall scope. `/viking` output and a real
takeover commit are untested against a live server.

## Tests

```sh
bun run test           # upstream's own unit tests, against the pinned checkout
bun run registration   # the port contract: tools exist before the first turn
bun run lifecycle      # server start, adoption, shutdown and lock handling
bun run smoke          # the whole thing through a real OMP process and model
```

Only the smoke test costs money and needs the `omp` binary on PATH; the other three are offline and
run in seconds. `bun run update` runs all but the lifecycle test on every bump.

## Update upstream

```sh
bun run update                                  # fetch latest upstream main, run the tests
bun run update -- v0.4.21                       # or a specific branch, tag or commit
git add upstream && git commit -m "Bump upstream"
```

The update fetches the ref, installs any missing dependency, regenerates `shared/`, re-applies
`patches/`, then runs upstream's unit tests and this fork's smoke test. A rejected patch or a
failing test stops it and leaves the new commit checked out for you to resolve. Add `--no-smoke` to
skip the smoke test, which makes real model calls.

## License

Apache-2.0, inherited from upstream's `examples/LICENSE`. See `NOTICE`.
