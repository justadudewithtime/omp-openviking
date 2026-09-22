# Patches

## How this directory works

`upstream/` is a git submodule pointing at `volcengine/OpenViking`, pinned at a commit. It is never
hand-edited and no upstream file is copied into this repository. Every oh-my-pi specific change to
that tree that cannot live outside it belongs here as a unified diff.

- Patches apply into the submodule working tree with `git -C upstream apply -p1`, so their diff
  labels are rooted at the **submodule root**: `a/examples/pi-coding-agent-extension/index.ts`, not
  `a/upstream/index.ts`. Getting this prefix wrong is the one mistake that will bite you.
- `applyPatches()` in `scripts/lib/upstream.mjs` applies every `*.patch` file in lexicographic
  filename order, which is what the `NNNN-` prefix is for. Both `bun run setup` and `bun run update`
  call it. This file (`patches/README.md`) is skipped because it is not a `.patch` file.
- A failed patch is a hard stop, not a warning. The captured `git apply` output is printed, the
  script exits non-zero, and `bun run update` does not run the test suites. It never applies a
  partial patch set silently.
- **Prefer a root-level adapter to a patch.** A change that can be expressed as a module under
  `adapters/` should be. A patch has to be rebased by hand every time upstream moves the lines it
  touches, and it leaves the submodule working tree dirty. `bun run update` reverses the patch set
  before it looks for local changes, so that dirt alone never blocks a bump, but a patch that no
  longer reverses cleanly is a silent no-op in that step and a loud failure in the next one.

## The patch set

One patch, and it touches a test rather than the extension.

- `0001-windows-import-file-url.patch`, created against `184a5cec`. Upstream's
  `tests/handshake-once.test.mjs` loads the extension with `await import(join(EXTENSION_DIR,
  "index.ts"))`. Node's ESM loader rejects a Windows absolute path (`Received protocol 'c:'`), so
  all six of that file's tests fail here and `bun run update` refuses the bump. The patch switches
  both call sites to the `EXTENSION_URL` `file://` prefix the same file already computes. It is a
  host-portability fix, so it stays until upstream makes the same change.

The behavior oh-my-pi needs changed, tool registration timing, is still done from outside by
`adapters/tool-registration.ts`: it performs the MCP handshake at extension-factory time and
registers the catalogue through upstream's own `registerMcpTools()`. The extension itself is not
modified.

## How to add a patch

1. Make sure the checkout is clean: `git -C upstream status --porcelain` prints nothing.
2. Edit the file under `upstream/examples/pi-coding-agent-extension/`.
3. Capture the diff, from the repository root:

   ```sh
   git -C upstream diff > patches/0001-my-change.patch
   ```

   The labels come out submodule-rooted, which is what `git -C upstream apply -p1` wants.

4. Verify it applies to a clean checkout, not just to your working tree:

   ```sh
   git -C upstream checkout -- .
   git -C upstream apply --check -p1 ../patches/0001-my-change.patch
   ```

5. Run `bun run update -- <the currently pinned ref>`. It resets, re-applies the whole patch set
   from scratch, and runs both suites. That is the only check that proves the patch is complete.

## How to retire a patch

`bun run update` rejects a patch when upstream moves the lines it touches. If upstream absorbed the
change:

1. Read the new upstream code and confirm it has the same effect. A rejected hunk can also mean
   upstream moved the code without fixing anything, which is a rebase, not a retirement.
2. Delete the patch file.
3. Delete the adapter module it called if nothing else imports it.
4. Record the upstream ref that made it unnecessary in the History section below.
5. Re-run `bun run update` and the smoke test.

## Deliberately not patched

All of the following were tested against oh-my-pi and work with upstream unmodified, so no patch
exists for any of them:

- `@earendil-works/*` imports and the bare `typebox` import: OMP's loader rewrites them onto
  host-bundled copies.
- Extension-local `.mjs` files under `lib/` and `shared/`.
- TypeScript `./x.js` specifiers resolving to `x.ts`.
- The `session_start` chain: health check, system status, profile listing, and profile read.
- Recall injection: the `<openviking-context>` block reaches the model.
- `turn_end` capture, including assistant tool parts and paired tool results. There is no
  message-shape mismatch against OMP session entries.
- `omp -c` continuation through `before_agent_start`, and takeover state restore.
- `ctx.ui.setStatus`: already guarded by a `typeof` check upstream, so the status footer degrades
  silently on hosts that do not provide it.
- Tool registration timing, as of the move to `adapters/tool-registration.ts`. It was
  `0001-register-tools-at-factory-time.patch` while `upstream/` was vendored.
- The second MCP connection. Once the adapter has registered the catalogue, upstream's own bridge
  is redundant: it connects, lists, registers into a host that drops the duplicates, and serves no
  call. Forcing `mcpEnabled: false` on upstream would save that handshake, at the price of
  `/viking` reporting a disabled tool surface that is in fact serving every call. A local
  handshake is milliseconds; the honest status line is worth more.
- `<ext>/shared/`, which upstream generates instead of committing. `scripts/lib/upstream.mjs` runs
  upstream's own generator (`examples/memory-plugin-shared/sync.mjs`) and restores the committed
  copies it refreshes for other harnesses, so the submodule ends clean.

## History

- `0001-register-tools-at-factory-time.patch`, created against `v0.4.20`
  (`b54001e2e5c974ffd7a09ba543813fa104a99561`), retired when `upstream/` became a submodule. Its
  effect moved into `adapters/tool-registration.ts` unchanged; upstream never needed the edit, the
  vendored layout just made a patch the convenient way to call the adapter.
- The `0001-` prefix was free again when the Windows import fix was written, so it was reused. A
  patch number is an ordering, not an identity.
