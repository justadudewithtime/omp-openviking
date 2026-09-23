/**
 * Shared helpers for the upstream submodule: initialization, the pinned commit,
 * and patch application. Zero dependencies, node:* builtins only.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root, derived from this file's location and never from cwd. */
export const repoRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));

/** Submodule working tree: the whole volcengine/OpenViking repository. */
export const SUBMODULE = "upstream";
export const SUBMODULE_DIR = join(repoRoot, SUBMODULE);

/** The extension's path inside that repository. */
export const EXT_SUBPATH = "examples/pi-coding-agent-extension";
export const EXT_DIR = join(SUBMODULE_DIR, ...EXT_SUBPATH.split("/"));

export const PATCHES_DIR = join(repoRoot, "patches");

/**
 * Files that must exist for the extension to be loadable at all. `config.json`
 * was one of them until upstream deleted it: every knob now resolves
 * from env, the workspace and `ovcli.conf` through `shared/config-schema.mjs`.
 * `package.json` replaced it as the file that must be there, because it carries
 * the extension version and the MCP client dependency.
 */
const REQUIRED_FILES = ["index.ts", "tools.ts", "package.json"];

/**
 * Bare npm specifiers upstream imports. They are dependencies of this
 * repository, installed once into the root `node_modules/`, which Node finds by
 * walking up from `upstream/examples/pi-coding-agent-extension/`. Installing
 * them inside the submodule instead would leave an untracked `node_modules/`
 * there, which upstream's .gitignore does not cover.
 */
const RUNTIME_DEPENDENCIES = ["@modelcontextprotocol/client"];

/** The generator that materializes `<ext>/shared/` from memory-plugin-shared. */
const SHARED_GENERATOR = ["examples", "memory-plugin-shared", "sync.mjs"];

/** One generated module, proof the sync ran and wrote where we expect. */
const SHARED_WITNESS = ["shared", "ov-http.mjs"];

/**
 * Run git. Returns { status, stdout, stderr }; `inherit` streams to the
 * console instead of capturing. Throws only when git itself is unavailable.
 */
export function git(args, { cwd = repoRoot, inherit = false } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    shell: false,
    encoding: "utf8",
    stdio: inherit ? "inherit" : "pipe",
  });
  if (result.error) {
    throw new Error(`could not run git: ${result.error.message}`);
  }
  // Trailing whitespace only: `git status --porcelain` puts the path in
  // column 3, so a leading trim would shift every path left by one.
  return {
    status: result.status ?? 1,
    stdout: (result.stdout ?? "").replace(/\s+$/, ""),
    stderr: (result.stderr ?? "").replace(/\s+$/, ""),
  };
}

/** Exit with a message on stderr. */
export function fail(message) {
  console.error(message);
  process.exitCode = 1;
  return false;
}

/**
 * Initialize the submodule when absent, then assert the extension subpath is
 * where we expect it. Returns true on success.
 */
export function ensureSubmodule() {
  if (!existsSync(join(SUBMODULE_DIR, ".git"))) {
    console.log(`initializing submodule ${SUBMODULE} (shallow)`);
    const init = git(["submodule", "update", "--init", "--depth", "1", SUBMODULE], {
      inherit: true,
    });
    if (init.status !== 0) {
      return fail(
        `git submodule update --init failed (exit ${init.status}). ` +
          `Check network access to https://github.com/volcengine/OpenViking.git`,
      );
    }
  }

  const missing = REQUIRED_FILES.filter((name) => !existsSync(join(EXT_DIR, name)));
  if (missing.length > 0) {
    return fail(
      `upstream is checked out but ${SUBMODULE}/${EXT_SUBPATH} is missing ` +
        `${missing.join(", ")}. The upstream extension subpath probably moved; ` +
        `update EXT_SUBPATH in scripts/lib/upstream.mjs and the import paths in ` +
        `index.ts and adapters/tool-registration.ts.`,
    );
  }
  return true;
}

/** The commit the submodule is checked out at. */
export function pinnedSha() {
  const head = git(["rev-parse", "HEAD"], { cwd: SUBMODULE_DIR });
  return head.status === 0 ? head.stdout : "unknown";
}

export function shortSha(sha) {
  return sha.slice(0, 8);
}

/** Entries modified inside the submodule working tree: { code, path }. */
export function submoduleDirtyEntries() {
  const status = git(["status", "--porcelain"], { cwd: SUBMODULE_DIR });
  if (status.status !== 0 || status.stdout === "") return [];
  return status.stdout
    .split(/\r?\n/)
    .map((line) => ({ code: line.slice(0, 2), path: line.slice(3).trim() }))
    .filter((entry) => entry.path !== "");
}

/** Paths modified inside the submodule working tree, relative to its root. */
export function submoduleDirtyPaths() {
  return submoduleDirtyEntries().map((entry) => entry.path);
}

/**
 * Materialize `<ext>/shared/`, which upstream stopped committing: the
 * directory is a generated copy of `examples/memory-plugin-shared/lib`, ignored
 * by upstream's .gitignore and written by that directory's sync.mjs. Without
 * this step every import of `./shared/*.mjs` is an ERR_MODULE_NOT_FOUND on the
 * first hook.
 *
 * The generator refreshes every harness's copies, not just this one. The
 * committed ones come back byte-identical except where this checkout holds CRLF
 * (git's autocrlf) and the generator writes LF, so anything this run dirtied
 * that was clean before is restored: an update that left the submodule modified
 * would refuse to move on the next run.
 *
 * Returns true on success.
 */
export function syncSharedOrReport() {
  const generator = join(SUBMODULE_DIR, ...SHARED_GENERATOR);
  if (!existsSync(generator)) {
    return fail(
      `${SUBMODULE}/${SHARED_GENERATOR.join("/")} is missing. Upstream moved the ` +
        `shared-module generator; find its new path and update SHARED_GENERATOR ` +
        `in scripts/lib/upstream.mjs.`,
    );
  }

  const before = new Set(submoduleDirtyPaths());
  const result = spawnSync(process.execPath, [generator], {
    cwd: SUBMODULE_DIR,
    shell: false,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error) throw new Error(`could not run the shared sync: ${result.error.message}`);
  if ((result.status ?? 1) !== 0) {
    return fail(
      `the shared-module sync failed (exit ${result.status}):\n` +
        [result.stdout, result.stderr].filter(Boolean).join("\n"),
    );
  }

  const collateral = submoduleDirtyEntries()
    .filter((entry) => !entry.code.includes("?") && !before.has(entry.path))
    .map((entry) => entry.path);
  if (collateral.length > 0) {
    const restore = git(["checkout", "--", ...collateral], { cwd: SUBMODULE_DIR });
    if (restore.status !== 0) {
      return fail(`could not restore regenerated upstream copies:\n${restore.stderr}`);
    }
  }

  const witness = join(EXT_DIR, ...SHARED_WITNESS);
  if (!existsSync(witness)) {
    return fail(
      `the shared sync ran but ${EXT_SUBPATH}/${SHARED_WITNESS.join("/")} is still ` +
        `missing. Upstream probably dropped this extension from the generator's ` +
        `TARGETS; read examples/memory-plugin-shared/sync.mjs.`,
    );
  }
  console.log(`generated ${EXT_SUBPATH}/shared/ (${collateral.length} collateral copies restored)`);
  return true;
}

/**
 * Install the npm packages upstream imports by bare specifier into this
 * repository's root node_modules. Bun when it is on PATH, npm otherwise; both
 * resolve the same versions from package.json. Returns true on success.
 */
export function ensureDependenciesOrReport() {
  const missing = RUNTIME_DEPENDENCIES.filter(
    (name) => !existsSync(join(repoRoot, "node_modules", ...name.split("/"))),
  );
  if (missing.length === 0) return true;

  console.log(`installing ${missing.join(", ")}`);
  const bun = spawnSync("bun", ["--version"], { shell: false, encoding: "utf8" });
  const manager = bun.error || (bun.status ?? 1) !== 0 ? "npm" : "bun";
  const install = spawnSync(manager, manager === "bun" ? ["install"] : ["install", "--no-audit", "--no-fund"], {
    cwd: repoRoot,
    shell: process.platform === "win32",
    stdio: "inherit",
  });
  if (install.error) {
    return fail(`could not run ${manager} install: ${install.error.message}`);
  }
  if ((install.status ?? 1) !== 0) {
    return fail(`${manager} install failed (exit ${install.status}).`);
  }

  const stillMissing = missing.filter(
    (name) => !existsSync(join(repoRoot, "node_modules", ...name.split("/"))),
  );
  if (stillMissing.length > 0) {
    return fail(`${manager} install finished but ${stillMissing.join(", ")} is not installed.`);
  }
  return true;
}

/**
 * Apply every patches/*.patch into the submodule working tree, in
 * lexicographic filename order. Patches already applied by an earlier run are
 * reversed first, so re-running setup re-applies the set instead of failing.
 * Returns [{ name, ok, detail }].
 */
export function applyPatches() {
  if (!existsSync(PATCHES_DIR)) return [];
  revertAppliedPatches();
  const names = readdirSync(PATCHES_DIR)
    .filter((name) => name.endsWith(".patch"))
    .sort();

  return names.map((name) => {
    const result = git(["apply", "-p1", join(PATCHES_DIR, name)], { cwd: SUBMODULE_DIR });
    return {
      name,
      ok: result.status === 0,
      detail: [result.stdout, result.stderr].filter(Boolean).join("\n"),
    };
  });
}

/**
 * Reverse every patch that is currently applied, newest first, so the only
 * modifications left in the submodule are the ones a human made. Patch dirt is
 * expected dirt: it is re-applied at the end of every setup and update, and
 * making the update refuse to run because of it would mean passing --force on
 * every bump, which also discards real local work without asking.
 *
 * Silent by design: a patch that does not reverse cleanly was not applied, and
 * the checkout that follows replaces those files anyway.
 */
export function revertAppliedPatches() {
  if (!existsSync(PATCHES_DIR)) return;
  const names = readdirSync(PATCHES_DIR)
    .filter((name) => name.endsWith(".patch"))
    .sort()
    .reverse();
  for (const name of names) {
    const patch = join(PATCHES_DIR, name);
    const check = git(["apply", "-R", "--check", "-p1", patch], { cwd: SUBMODULE_DIR });
    if (check.status !== 0) continue;
    git(["apply", "-R", "-p1", patch], { cwd: SUBMODULE_DIR });
  }
}

/**
 * Apply patches and report. Returns true when every patch applied (or there
 * were none), false after printing the captured git apply output.
 */
export function applyPatchesOrReport() {
  const results = applyPatches();
  if (results.length === 0) {
    console.log("no patches to apply");
    return true;
  }
  for (const result of results) {
    console.log(`${result.ok ? "applied" : "FAILED "} ${result.name}`);
  }
  const failures = results.filter((result) => !result.ok);
  if (failures.length === 0) return true;
  for (const failure of failures) {
    console.error(`\n--- ${failure.name} ---\n${failure.detail || "(no output)"}`);
  }
  return fail(
    `\n${failures.length} of ${results.length} patches did not apply. ` +
      `Rebase them against the current checkout; see patches/README.md.`,
  );
}
