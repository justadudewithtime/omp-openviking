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

You need a running `openviking-server` (see getting started). `OPENVIKING_URL` overrides the
default `http://127.0.0.1:1933`. Everything else is tuned in
`upstream/examples/pi-coding-agent-extension/config.json`, documented upstream. Editing that file
dirties the submodule, so `bun run update` will ask you to copy it aside first (or pass `--force`,
which backs it up for you).

## What differs from upstream

One change: `adapters/tool-registration.ts` registers the tools when the extension loads, because
OMP builds the turn's tool set before upstream's `session_start` hook resolves. Until the server
answers, a tool call reports the server as unreachable instead of the tool being missing.

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
