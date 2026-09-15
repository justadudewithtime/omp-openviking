/**
 * Update the upstream submodule, re-apply patches, and run both test suites.
 *
 *   node scripts/update-upstream.mjs [<ref>] [--force] [--no-smoke]
 *
 * <ref> is any branch, tag or commit in volcengine/OpenViking (default: main).
 * --force discards local edits inside the submodule checkout, backing up
 * config.json first. --no-smoke skips the smoke test, which makes real model
 * calls. Nothing is staged or committed; the printed commands do that.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  EXT_SUBPATH,
  SUBMODULE_DIR,
  applyPatchesOrReport,
  ensureSubmodule,
  git,
  pinnedSha,
  repoRoot,
  shortSha,
  submoduleDirtyPaths,
} from "./lib/upstream.mjs";

const CONFIG_SUBPATH = `${EXT_SUBPATH}/config.json`;

const argv = process.argv.slice(2);
const force = argv.includes("--force");
const skipSmoke = argv.includes("--no-smoke");
const positional = argv.filter((arg) => !arg.startsWith("--"));

if (positional.length > 1) {
  console.error(`expected at most one ref, got: ${positional.join(", ")}`);
  process.exit(1);
}
const ref = positional[0] ?? "main";

function die(message) {
  console.error(message);
  process.exit(1);
}

/** Run a command with inherited stdio; returns its exit status. */
function run(label, command, args) {
  console.log(`\n== ${label}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    shell: false,
    stdio: "inherit",
  });
  if (result.error) die(`could not run ${command}: ${result.error.message}`);
  return result.status ?? 1;
}

if (!ensureSubmodule()) process.exit(1);
const before = pinnedSha();

// 1. Refuse to discard local work in the submodule checkout.
const dirty = submoduleDirtyPaths();
if (dirty.length > 0) {
  if (!force) {
    die(
      `upstream checkout has local changes:\n` +
        dirty.map((path) => `  ${path}`).join("\n") +
        `\n\nA checkout would discard them. Either:\n` +
        `  1. copy ${CONFIG_SUBPATH} aside, run ` +
        `\`git -C upstream checkout -- .\`, re-run this script, then re-apply\n` +
        `     your edits; or\n` +
        `  2. re-run with --force, which backs up config.json to ` +
        `config.json.bak and discards the rest.`,
    );
  }
  if (dirty.includes(CONFIG_SUBPATH)) {
    const backup = join(repoRoot, "config.json.bak");
    copyFileSync(join(SUBMODULE_DIR, ...CONFIG_SUBPATH.split("/")), backup);
    console.log(`--force: backed up your config.json to ${backup}`);
  }
  const reset = git(["checkout", "--", "."], { cwd: SUBMODULE_DIR });
  if (reset.status !== 0) die(`could not reset the upstream checkout:\n${reset.stderr}`);
  console.log(`--force: discarded ${dirty.length} local change(s) in upstream/`);
}

// 2. Fetch the requested ref shallowly and resolve it to a commit.
console.log(`\n== fetching ${ref} from origin`);
const fetch = git(["fetch", "--depth", "1", "origin", ref], {
  cwd: SUBMODULE_DIR,
  inherit: true,
});
if (fetch.status !== 0) {
  die(
    `git fetch --depth 1 origin ${ref} failed (exit ${fetch.status}).\n` +
      `If the server refused a shallow fetch of that object, run ` +
      `\`git -C upstream fetch --unshallow\` (downloads the full ~261 MB repo) ` +
      `and re-run.`,
  );
}
const resolved = git(["rev-parse", "FETCH_HEAD"], { cwd: SUBMODULE_DIR });
if (resolved.status !== 0) die(`could not resolve FETCH_HEAD:\n${resolved.stderr}`);
const after = resolved.stdout;

// 3. Check it out detached.
const checkout = git(["checkout", "--detach", after], { cwd: SUBMODULE_DIR });
if (checkout.status !== 0) die(`could not check out ${after}:\n${checkout.stderr}`);
console.log(`upstream now at ${shortSha(after)} (was ${shortSha(before)})`);

// 4. Patches. A rejection stops here, with the new commit left on disk.
console.log(`\n== applying patches`);
if (!applyPatchesOrReport()) {
  console.error(
    `\nThe upstream checkout is left at ${shortSha(after)} so you can rebase ` +
      `the patches against it. \`git -C upstream checkout --detach ` +
      `${shortSha(before)}\` goes back.`,
  );
  process.exit(1);
}

// 5. Upstream's own unit tests.
const unitStatus = run("upstream unit tests", process.execPath, [
  "--test",
  `upstream/${EXT_SUBPATH}/tests/*.test.mjs`,
]);
if (unitStatus !== 0) {
  die(`\nupstream unit tests failed (exit ${unitStatus}) at ${shortSha(after)}.`);
}

// 6. This fork's port contract, unless skipped.
if (skipSmoke) {
  console.log(`\n== smoke test skipped (--no-smoke)`);
} else if (!existsSync(join(repoRoot, "test", "smoke.mjs"))) {
  die("test/smoke.mjs is missing");
} else {
  const smokeStatus = run("smoke test", process.execPath, ["test/smoke.mjs"]);
  if (smokeStatus !== 0) {
    die(`\nsmoke test failed (exit ${smokeStatus}) at ${shortSha(after)}.`);
  }
}

console.log(
  `\nupdate ok: upstream ${shortSha(before)} -> ${shortSha(after)}\n` +
    `\nRecord the bump with:\n` +
    `  git add upstream\n` +
    `  git commit -m "Bump upstream to ${shortSha(after)}"`,
);
process.exit(0);
