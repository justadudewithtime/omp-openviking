/**
 * oh-my-pi entry point for omp-openviking.
 *
 * The whole extension lives in `upstream/`, vendored verbatim from
 * volcengine/OpenViking `examples/pi-coding-agent-extension` with the diffs in
 * `patches/` applied. This file exists so the repository root is a valid
 * extension directory (`package.json#omp.extensions` points here) without
 * adding a file to the vendored tree.
 */
export { default } from "./upstream/index.js";
