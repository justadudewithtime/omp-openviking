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

/** Files that must exist for the extension to be loadable at all. */
const REQUIRED_FILES = ["index.ts", "tools.ts", "config.json"];

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

/** Paths modified inside the submodule working tree, relative to its root. */
export function submoduleDirtyPaths() {
  const status = git(["status", "--porcelain"], { cwd: SUBMODULE_DIR });
  if (status.status !== 0 || status.stdout === "") return [];
  return status.stdout
    .split(/\r?\n/)
    .map((line) => /^..\s(.*)$/.exec(line)?.[1]?.trim() ?? "")
    .filter((line) => line !== "");
}

/**
 * Apply every patches/*.patch into the submodule working tree, in
 * lexicographic filename order. Returns [{ name, ok, detail }].
 */
export function applyPatches() {
  if (!existsSync(PATCHES_DIR)) return [];
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
