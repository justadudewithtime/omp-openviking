/**
 * One-time setup: initialize the upstream submodule, install the npm packages
 * it imports, generate its `shared/` directory and apply patches/*.patch.
 * Safe to re-run; it never fetches a new commit (use scripts/update-upstream.mjs).
 *
 *   node scripts/setup.mjs
 */
import {
  applyPatchesOrReport,
  ensureDependenciesOrReport,
  ensureSubmodule,
  pinnedSha,
  syncSharedOrReport,
} from "./lib/upstream.mjs";

if (!ensureSubmodule()) process.exit(1);
if (!ensureDependenciesOrReport()) process.exit(1);
if (!syncSharedOrReport()) process.exit(1);
if (!applyPatchesOrReport()) process.exit(1);

console.log(`setup ok: upstream at ${pinnedSha()}`);
process.exit(0);
