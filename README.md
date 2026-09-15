# omp-openviking

[OpenViking](https://openviking.ai/en/getting-started/) context memory for
[oh-my-pi](https://github.com/badlogic/pi-mono), ported from upstream's
`examples/pi-coding-agent-extension`. Upstream is a git submodule under `upstream/`, pinned by
gitlink (`git submodule status upstream`), and is never edited: the only OMP specific code is
`adapters/tool-registration.ts`.

You get upstream's seven tools unchanged (`viking_search`, `viking_read`, `viking_browse`,
`viking_remember`, `viking_forget`, `viking_add_resource`, `viking_archive_expand`), automatic
recall injection, turn capture, and takeover. This README covers only what is specific to running
it under OMP. For everything about OpenViking itself, read the official docs:

- [Getting started](https://openviking.ai/en/getting-started/) (install and run the server)
- [Configuration](https://openviking.ai/en/configuration/) (every tuning field and env var)
- [Agent integrations: pi](https://openviking.ai/en/agent-integrations/11-pi)

## Requirements

- A reachable `openviking-server`. See [getting started](https://openviking.ai/en/getting-started/).
- `git`, for the submodule.
- Node 22.18 or newer to run `bun run test`: upstream's `.mjs` tests import `.ts` modules and rely
  on native type stripping. Measured clean on Node v24.1.0.

## Install

```sh
git clone --recurse-submodules --shallow-submodules \
  https://github.com/justadudewithtime/omp-openviking.git \
  ~/.omp/agent/extensions/openviking
```

If you forgot `--recurse-submodules`, run `bun run setup` in the clone. `~/.omp/agent/extensions`
is discovered automatically. Two other paths work identically: an `extensions:` entry in
`~/.omp/agent/config.yml`, or `<cwd>/.omp/extensions` for a single project. Either way the
directory resolves as an extension because `package.json#omp.extensions` points at `index.ts`.

## OMP configuration

```yaml
# ~/.omp/agent/config.yml
extensions:
  - ~/.omp/agent/extensions/openviking
memory:
  backend: off
```

`backend: off` is the important line. An active OMP memory backend injects its own Memory Guidance
block alongside this extension's `<openviking-context>` block and pays for turn extraction twice.

`OPENVIKING_URL` is the one variable most people set (default `http://127.0.0.1:1933`). On Windows,
`OPENVIKING_DEBUG_LOG` needs a native path such as `C:\Users\you\ov.log`; an MSYS style
`/c/Users/...` path is silently dropped.

Everything else is upstream's, documented at <https://openviking.ai/en/configuration/> and in
`upstream/examples/pi-coding-agent-extension/README.md`. One fork specific caveat: those tuning
fields live in `upstream/examples/pi-coding-agent-extension/config.json`, which is inside a git
submodule, so editing it makes the submodule dirty and `bun run update` refuses to proceed until
you copy it aside (or pass `--force`, which backs it up to `config.json.bak`).

## What differs under OMP

`adapters/tool-registration.ts` registers the `viking_*` tools at extension factory time, because
OMP assembles the turn's tool set before upstream's `session_start` chain resolves and the tools
would otherwise be missing from the turn that starts the session. A call made before the server
answers reports the server as unreachable rather than the tool being absent.

Known gaps against upstream's pi integration, all host limitations rather than bugs:

- An extension cannot own `/memory` subcommands; built-in command names are reserved.
- An extension cannot own the `memory://` protocol; there is no host registration API for it.
- Auto-retain cadences and subagent memory aliasing are not hookable, so subagents do not share the
  parent's recall scope.

`/viking` output and a real takeover commit at the 30000 token threshold are untested against a
live server: the test harness uses a stub.

## Update upstream

```sh
bun run update                 # newest main
bun run update -- v0.4.21      # a specific branch, tag or commit
bun run update -- main --no-smoke   # skip the smoke test, which makes real model calls
bun run update -- main --force      # discard local edits in upstream/, backing up config.json
```

In order: fetch the ref shallowly, check it out detached, apply `patches/*.patch`, run upstream's
unit tests, run this fork's smoke test. It exits non-zero on a rejected patch or a failing test and
leaves the checkout at the new commit so you can resolve it by hand. On success, record the bump:

```sh
git add upstream && git commit -m "Bump upstream to <sha>"
```

`patches/` is empty on purpose. A patch dirties the submodule and has to be rebased whenever
upstream moves, so a root level adapter is always preferred; see `patches/README.md`.

## License

Apache-2.0, inherited from upstream's `examples/LICENSE`. The upstream repository root is AGPLv3,
and nothing outside `examples/pi-coding-agent-extension` is imported, so nothing here is AGPL. Note
that a recursive clone does put the whole upstream repository on your disk, AGPL directories
included; this repository distributes none of it. See `NOTICE`.
