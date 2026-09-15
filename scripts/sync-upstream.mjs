#!/usr/bin/env node
/**
 * Re-vendor the upstream OpenViking pi extension subpath and reapply patches.
 *
 * Usage:
 *   node scripts/sync-upstream.mjs            # re-sync at the recorded ref (drift check)
 *   node scripts/sync-upstream.mjs v0.4.21    # re-vendor at a new tag, branch, or SHA
 *   bun run sync -- v0.4.21
 *
 * No git remote, no submodule, no npm dependency. `git` is used only for
 * `git apply`, and `tar` only for extracting the one subpath we vendor.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "volcengine/OpenViking";
const REPO_URL = `https://github.com/${REPO}`;
const SUBPATH = "examples/pi-coding-agent-extension";
/** Files that must exist after extraction, or the tarball layout changed. */
const SENTINELS = ["index.ts", "tools.ts", "config.json"];
/** Repo-owned metadata that lives inside upstream/, never compared as upstream content. */
const METADATA = "UPSTREAM.json";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const upstreamDir = join(repoRoot, "upstream");
const patchesDir = join(repoRoot, "patches");
const metadataPath = join(upstreamDir, METADATA);

const out = (line) => process.stdout.write(`${line}\n`);
const err = (line) => process.stderr.write(`${line}\n`);

function die(message) {
  err(`sync-upstream: ${message}`);
  process.exit(1);
}

// ----------------------------------------------------------------- networking
//
// Everything here is synchronous curl rather than fetch. Calling
// process.exit() while an undici fetch handle is still closing trips a libuv
// assertion on Windows (`!(handle->flags & UV_HANDLE_CLOSING)`) and the
// process aborts with code 9 instead of the exit code we chose. curl also
// keeps this script's dependency surface to the tools the README already
// requires.

/** Run curl, writing the response body to `bodyFile`; returns the HTTP status. */
function curlTo(url, bodyFile, extraArgs = []) {
  const args = [
    "-sS",
    "-L",
    "--retry",
    "2",
    "--retry-delay",
    "1",
    ...extraArgs,
    "-o",
    bodyFile,
    "-w",
    "%{http_code}",
    url,
  ];
  const result = spawnSync("curl", args, { encoding: "utf8", shell: false });
  if (result.error) die(`curl failed to run: ${result.error.message}`);
  if (result.status !== 0) {
    die(`curl exited ${result.status} for ${url}\n  ${(result.stderr || "").trim()}`);
  }
  return Number.parseInt((result.stdout || "").trim(), 10);
}

function githubApiArgs() {
  const args = [
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
    "-A",
    "omp-openviking-sync",
  ];
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) args.push("-H", `Authorization: Bearer ${token}`);
  return args;
}

/** Resolve a tag, branch, or SHA to its commit SHA. */
function resolveRef(ref, work) {
  const url = `https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(ref)}`;
  const bodyFile = join(work, "commit.json");
  const status = curlTo(url, bodyFile, githubApiArgs());
  const body = existsSync(bodyFile) ? readFileSync(bodyFile, "utf8") : "";
  if (status < 200 || status >= 300) {
    die(
      `cannot resolve ref "${ref}": HTTP ${status}\n  ${url}\n  ${body.slice(0, 400)}\n` +
        `  (unauthenticated GitHub API calls are rate limited; set GITHUB_TOKEN to raise the limit)`,
    );
  }
  let commit;
  try {
    commit = JSON.parse(body);
  } catch {
    die(`ref "${ref}" returned a body that is not JSON:\n  ${body.slice(0, 200)}`);
  }
  if (typeof commit.sha !== "string") die(`ref "${ref}" resolved to a response with no sha`);
  return commit.sha;
}

/** Download the first candidate tarball URL that answers 2xx. */
function downloadTarball(ref, sha, destFile) {
  const candidates = [];
  // A tag ref needs the refs/tags form; a SHA works directly. Try the most
  // specific candidate first and fall back to the immutable SHA URL.
  if (/^v?\d/.test(ref) && ref !== sha) {
    candidates.push(`https://codeload.github.com/${REPO}/tar.gz/refs/tags/${encodeURIComponent(ref)}`);
  }
  candidates.push(`https://codeload.github.com/${REPO}/tar.gz/${sha}`);

  const failures = [];
  for (const url of candidates) {
    const status = curlTo(url, destFile, ["-A", "omp-openviking-sync"]);
    if (status >= 200 && status < 300) return url;
    failures.push(`HTTP ${status} ${url}`);
  }
  die(`tarball download failed:\n  ${failures.join("\n  ")}`);
}

// ------------------------------------------------------------------ tree walk

/** Relative paths of every file under `root`, POSIX separators, sorted. */
function listFiles(root, base = root, acc = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) listFiles(full, base, acc);
    else if (entry.isFile()) acc.push(relative(base, full).split(sep).join("/"));
  }
  return acc.sort();
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Compare a freshly extracted tree against the current vendored tree.
 * Files touched by patches legitimately differ, so this is reported, never fatal.
 */
function rawDrift(freshDir, currentDir) {
  if (!existsSync(currentDir)) return { added: [], removed: [], changed: [], fresh: true };
  const fresh = new Set(listFiles(freshDir));
  const current = new Set(listFiles(currentDir).filter((p) => p !== METADATA));
  const added = [...fresh].filter((p) => !current.has(p));
  const removed = [...current].filter((p) => !fresh.has(p));
  const changed = [...fresh]
    .filter((p) => current.has(p))
    .filter((p) => digest(join(freshDir, p)) !== digest(join(currentDir, p)));
  return { added, removed, changed, fresh: false };
}

// --------------------------------------------------------------------- patches

function patchFiles() {
  if (!existsSync(patchesDir)) return [];
  return readdirSync(patchesDir)
    .filter((name) => name.endsWith(".patch"))
    .sort();
}

function applyPatch(name) {
  const result = spawnSync("git", ["apply", "-p1", "--verbose", join("patches", name)], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
  });
  const ok = result.status === 0;
  const detail = [result.stdout, result.stderr, result.error?.message]
    .filter(Boolean)
    .join("\n")
    .trim();
  return { name, ok, detail };
}

// ------------------------------------------------------------------------ main

const requestedRef = process.argv[2];
let ref = requestedRef;
if (!ref) {
  if (!existsSync(metadataPath)) die("no ref argument and no upstream/UPSTREAM.json to read one from");
  ref = JSON.parse(readFileSync(metadataPath, "utf8")).ref;
  if (!ref) die("upstream/UPSTREAM.json has no ref field");
  out(`no ref given, re-syncing at the recorded ref ${ref} (drift check)`);
}

const work = mkdtempSync(join(tmpdir(), "omp-openviking-sync-"));
let exitCode = 0;
try {
  const sha = resolveRef(ref, work);
  out(`ref ${ref} -> ${sha}`);

  const tarball = join(work, "upstream.tar.gz");
  const url = downloadTarball(ref, sha, tarball);
  out(`downloaded ${url}`);

  const extractDir = join(work, "extract");
  mkdirSync(extractDir, { recursive: true });
  const untar = spawnSync(
    "tar",
    ["-xzf", tarball, "-C", extractDir, "--strip-components=3", `*/${SUBPATH}/*`],
    { encoding: "utf8", shell: false },
  );
  if (untar.status !== 0) {
    die(`tar extraction failed: ${[untar.stderr, untar.error?.message].filter(Boolean).join(" ")}`);
  }
  const missing = SENTINELS.filter((name) => !existsSync(join(extractDir, name)));
  if (missing.length) {
    die(
      `extraction produced no usable tree (missing ${missing.join(", ")}); ` +
        `the upstream subpath ${SUBPATH} may have moved at ${ref}`,
    );
  }
  const vendoredFiles = listFiles(extractDir);
  out(`extracted ${vendoredFiles.length} files from ${SUBPATH}`);

  // Drift is measured against the extracted tree before anything is replaced.
  const drift = rawDrift(extractDir, upstreamDir);
  out("");
  out("raw drift before patches (patched files are expected to differ):");
  if (drift.fresh) {
    out("  no existing upstream/ tree, nothing to compare");
  } else {
    out(`  added upstream:   ${drift.added.length}${drift.added.length ? ` (${drift.added.join(", ")})` : ""}`);
    out(`  removed upstream: ${drift.removed.length}${drift.removed.length ? ` (${drift.removed.join(", ")})` : ""}`);
    out(`  content differs:  ${drift.changed.length}${drift.changed.length ? ` (${drift.changed.join(", ")})` : ""}`);
  }

  rmSync(upstreamDir, { recursive: true, force: true });
  cpSync(extractDir, upstreamDir, { recursive: true });

  writeFileSync(
    metadataPath,
    `${JSON.stringify(
      {
        repo: REPO_URL,
        ref,
        sha,
        subpath: SUBPATH,
        vendored_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  out(`wrote upstream/${METADATA}`);

  const patches = patchFiles();
  out("");
  if (!patches.length) out("no patches to apply");
  const failures = [];
  for (const name of patches) {
    const result = applyPatch(name);
    out(`  ${result.ok ? "applied" : "FAILED "} ${name}`);
    if (!result.ok) failures.push(result);
  }

  if (failures.length) {
    exitCode = 1;
    err("");
    for (const failure of failures) {
      err(`patch rejected: patches/${failure.name}`);
      err(failure.detail || "(no output from git apply)");
      err("");
    }
    err(
      `${failures.length} of ${patches.length} patch(es) did not apply at ${ref}. ` +
        `Resolve each one by hand: rebase the diff onto the new upstream file, or retire the ` +
        `patch if upstream absorbed the change (see patches/README.md).`,
    );
  } else {
    out("");
    out(
      `sync ok: ${vendoredFiles.length} files at ${ref} (${sha.slice(0, 12)}), ` +
        `${patches.length} patch(es) applied, 0 rejects`,
    );
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

process.exit(exitCode);
