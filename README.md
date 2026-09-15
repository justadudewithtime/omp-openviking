# omp-openviking

OpenViking context memory for oh-my-pi, a fork of OpenViking's pi-coding-agent extension.

You get the seven `viking_*` tools, automatic recall, turn capture and takeover, unchanged from
upstream. For everything about OpenViking itself, read the official docs:

- [Getting started](https://openviking.ai/en/getting-started/) (install and run the server)
- [Configuration](https://openviking.ai/en/configuration/) (every tuning field and env var)
- [Agent integrations: pi](https://openviking.ai/en/agent-integrations/11-pi)

## Install

```sh
git clone --recurse-submodules --shallow-submodules \
  https://github.com/justadudewithtime/omp-openviking.git \
  ~/.omp/agent/extensions/openviking
```

Forgot `--recurse-submodules`? Run `bun run setup` inside the clone. Then tell OMP about it and
switch off OMP's own memory backend:

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
in `upstream/examples/pi-coding-agent-extension/config.json`, documented upstream. Editing that
file dirties the submodule, so `bun run update` will ask you to copy it aside first (or pass
`--force`, which backs it up for you).

## What differs from upstream

Two changes. `adapters/tool-registration.ts` registers the tools when the extension loads, because
OMP builds the turn's tool set before upstream's `session_start` hook resolves; until the server
answers, a tool call reports it as unreachable instead of the tool being missing.
`adapters/server-lifecycle.ts` adds the shared server lifecycle described above, which upstream
leaves to you.

Host limitations, not bugs: extensions cannot own `/memory` subcommands or the `memory://`
protocol, and subagents do not share the parent's recall scope. `/viking` output and a real
takeover commit are untested against a live server.

## Update upstream

```sh
bun run update                                  # fetch latest upstream main, run the tests
bun run update -- v0.4.21                       # or a specific branch, tag or commit
git add upstream && git commit -m "Bump upstream"
```

A rejected patch or a failing test stops the update and leaves the new commit checked out for you
to resolve. Add `--no-smoke` to skip the smoke test, which makes real model calls.

## License

Apache-2.0, inherited from upstream's `examples/LICENSE`. See `NOTICE`.
