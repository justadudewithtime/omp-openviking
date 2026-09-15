# Patches

## How this directory works

`upstream/` is vendored verbatim from `volcengine/OpenViking`, subpath
`examples/pi-coding-agent-extension`. It is never hand-edited. Every oh-my-pi specific change to
that tree lives here as a unified diff.

- Patches are unified diffs with `a/` and `b/` prefixes rooted at the repository root, so they
  apply with `git apply -p1` from the repository root.
- `scripts/sync-upstream.mjs` applies every `*.patch` file in lexicographic filename order, which
  is what the `NNNN-` prefix is for. This file (`patches/README.md`) is skipped because it is not a
  `.patch` file.
- A change that cannot be expressed as a small patch goes into a root-level adapter module under
  `adapters/`, and the patch is reduced to the line that calls it. That keeps the diff against
  upstream small enough to rebase by eye when upstream moves.
- A failed patch is a hard stop, not a warning. The sync script prints the captured `git apply`
  stderr, says which patch was rejected, and exits non-zero so a human resolves it. It never
  applies a partial patch set silently.

## How to add a patch

1. Vendor a clean tree into a temp directory:

   ```sh
   curl -sSL -o /tmp/ov.tar.gz https://codeload.github.com/volcengine/OpenViking/tar.gz/refs/tags/v0.4.20
   mkdir -p /tmp/ov-clean
   tar -xzf /tmp/ov.tar.gz -C /tmp/ov-clean --strip-components=3 "*/examples/pi-coding-agent-extension/*"
   ```

2. Edit the working copy under `upstream/` as usual.
3. Diff the clean file against the working copy, with repository-rooted labels:

   ```sh
   diff -u --label a/upstream/index.ts --label b/upstream/index.ts \
     /tmp/ov-clean/index.ts upstream/index.ts > patches/0002-my-change.patch
   ```

4. Verify the patch applies to a clean vendor, not just to your working tree:

   ```sh
   git apply --check -p1 patches/0002-my-change.patch
   ```

5. Run `node scripts/sync-upstream.mjs` once. It re-vendors, reports raw drift, and reapplies the
   whole patch set from scratch. That is the only check that proves the patch is complete.

## How to retire a patch

Run the sync at the new upstream ref. If a patch is rejected because upstream absorbed the change:

1. Read the new upstream code and confirm it has the same effect. A rejected hunk can also mean
   upstream moved the code without fixing anything, which is a rebase, not a retirement.
2. Delete the patch file.
3. Delete the adapter module it called if nothing else imports it.
4. Record the upstream ref that made it unnecessary in the History section below.
5. Re-run `node scripts/sync-upstream.mjs` and the smoke test.

## The patch set

### 0001-register-tools-at-factory-time.patch

Three hunks, all in `upstream/index.ts`:

1. Swap the import: `registerTools` from `./tools.js` becomes `registerToolsEagerly` from
   `../adapters/tool-registration.js`.
2. Drop the now-unused `toolsRegistered` flag and add the factory-time call
   `registerToolsEagerly(pi, client, sync, () => connected)`, placed after the client, sync, and
   `connected` declarations and before the first `await`.
3. Delete the late registration block inside `start()`.

**The oh-my-pi behavior that forces it.** Upstream calls `registerTools()` inside `start()`.
`start()` runs after an async health check, inside a fire-and-forget `session_start` handler. OMP has
already assembled the turn's tool set by the time that chain resolves, so the registrations land too
late and all seven tools (`viking_search`, `viking_read`, `viking_browse`, `viking_remember`,
`viking_forget`, `viking_add_resource`, `viking_archive_expand`) are simply absent from the turn that
started the session. Registration must therefore be synchronous, at extension-factory time.

**What the adapter adds.** `adapters/tool-registration.ts` wraps the host in a `Proxy` that
intercepts `registerTool` and forwards every other member untouched, so upstream's `registerTools()`
runs unmodified against what looks like a normal `ExtensionAPI`. Each tool's `execute` is wrapped
with a connectivity guard: while the extension's `connected` flag is false, the call returns
`{content: [{type: "text", text: "OpenViking server not reachable at <endpoint> ..."}],
isError: true}` instead of the tool being missing. `isConnected` is read at call time, never at
registration time, so the guard opens as soon as the health check succeeds, and after that the
wrapper is transparent and upstream's `execute` runs verbatim.

**What would retire it.** Upstream registering its tools synchronously at factory time, or gating
tool availability (rather than tool registration) on the health check. Either makes both the patch
and `adapters/tool-registration.ts` unnecessary.

## Deliberately not patched

All of the following were tested against oh-my-pi and work with the vendored code unmodified, so no
patch exists for any of them:

- `@earendil-works/*` imports and the bare `typebox` import: OMP's loader rewrites them onto
  host-bundled copies.
- Extension-local `.mjs` files under `upstream/lib/` and `upstream/shared/`.
- TypeScript `./x.js` specifiers resolving to `x.ts`.
- The `session_start` chain: health check, system status, profile listing, and profile read.
- Recall injection: the `<openviking-context>` block reaches the model.
- `turn_end` capture, including assistant tool parts and paired tool results. There is no
  message-shape mismatch against OMP session entries.
- `omp -c` continuation through `before_agent_start`, and takeover state restore.
- `ctx.ui.setStatus`: already guarded by a `typeof` check upstream, so the status footer degrades
  silently on hosts that do not provide it.

## History

No patch has been retired yet. The set was created against `v0.4.20`
(`b54001e2e5c974ffd7a09ba543813fa104a99561`).
