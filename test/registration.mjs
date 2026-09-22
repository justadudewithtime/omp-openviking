#!/usr/bin/env node
/**
 * Port contract test: the tools exist before the first turn.
 *
 * This is the reason the fork exists. Upstream's tool surface is the
 * OpenViking server's MCP catalogue, and upstream registers it inside an async
 * session_start chain that OMP has already passed by the time it resolves.
 * `adapters/tool-registration.ts` moves that handshake into the extension
 * factory, which OMP awaits.
 *
 * The smoke test proves the same thing through a real OMP process and a real
 * model. This one proves it in a second, against the stub, so a broken port is
 * caught before anyone pays for a provider round trip.
 *
 * Usage: node test/registration.mjs   (or: bun run registration)
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { startStubServer } from "./stub-server.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "..");
const repoUrl = pathToFileURL(repoRoot + "/").href;
const scratchDir = join(testDir, ".scratch-registration");

// TypeScript's `./x.js` specifiers resolve to `x.ts` inside the omp loader.
// Node does not do that, so the same fallback upstream's own tests install is
// installed here, widened to this repository because the adapters import
// upstream by relative path. Real resolution is tried first, so nothing that
// already resolves changes meaning.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const inRepo = typeof context?.parentURL === "string" && context.parentURL.startsWith(repoUrl);
    if (!inRepo || !specifier.startsWith(".") || !specifier.endsWith(".js")) {
      return nextResolve(specifier, context);
    }
    try {
      return nextResolve(specifier, context);
    } catch {
      return nextResolve(specifier.slice(0, -3) + ".ts", context);
    }
  },
});

/** The pi surface the extension factory touches, and nothing else. */
function fakePi() {
  const tools = [];
  const handlers = new Map();
  const pi = {
    registerTool(descriptor) {
      tools.push(descriptor);
      return descriptor;
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand() {},
  };
  return { pi, tools, handlers };
}

const results = [];
function report(name, passed, detail = "") {
  results.push({ name, passed });
  process.stdout.write(`${passed ? "PASS" : "FAIL"} ${name}\n`);
  if (!passed && detail) process.stdout.write(`${detail}\n`);
}

rmSync(scratchDir, { recursive: true, force: true });
mkdirSync(scratchDir, { recursive: true });

const canary = "OPENVIKING-CANARY-REGISTRATION";
// Port 0, not the stub's default 1933: this test must not fight a real
// OpenViking server running on the developer's machine.
const stub = await startStubServer({ port: 0, canary, logPath: join(scratchDir, "requests.jsonl") });

// The extension resolves its configuration and its workspace peer from the
// process cwd; the scratch directory keeps both out of the repository.
process.chdir(scratchDir);
process.env.OPENVIKING_URL = stub.url;
// The stub is already answering, so a spawn would only be a way to fail.
process.env.OPENVIKING_NO_AUTOSTART = "1";

try {
  // --- check 1: the factory registers the catalogue ------------------------
  const { pi, tools, handlers } = fakePi();
  const extension = (await import(pathToFileURL(join(repoRoot, "index.ts")).href)).default;
  await extension(pi);

  const names = tools.map((tool) => tool.name).sort();
  report(
    "factory-time-registration",
    names.length === 7 && names.every((name) => name.startsWith("openviking_")),
    `registered: ${JSON.stringify(names)}`,
  );
  // Nothing above fired a handler: session_start is registered and has not run,
  // which is the state OMP is in when it assembles the first turn's tool set.
  assert.ok(handlers.has("session_start"), "upstream should have registered session_start");

  // --- check 2: a registered tool actually reaches the server --------------
  const search = tools.find((tool) => tool.name === "openviking_search");
  let callDetail = "openviking_search was not registered";
  let called = false;
  if (search) {
    const result = await search.execute("call-1", { query: "project conventions" });
    const text = JSON.stringify(result);
    called = text.includes(canary);
    callDetail = `result: ${text.slice(0, 300)}`;
  }
  report("tool-call-reaches-stub", called, callDetail);

  // --- check 3: upstream's own registration is not duplicated --------------
  // Upstream's bridge lists the same catalogue a moment later and registers it
  // again. pi would either reject the second descriptor or replace a working
  // tool mid-session, so the host handed to upstream drops exactly those names
  // and forwards everything else.
  const { installOpenVikingTools } = await import(
    pathToFileURL(join(repoRoot, "adapters", "tool-registration.ts")).href
  );
  const second = fakePi();
  const host = await installOpenVikingTools(second.pi);
  const registeredHere = second.tools.length;
  host.registerTool({ name: "openviking_search", execute: async () => ({}) });
  const afterDuplicate = second.tools.length;
  host.registerTool({ name: "unrelated_tool", execute: async () => ({}) });
  const afterOther = second.tools.length;
  report(
    "duplicate-registration-dropped",
    registeredHere === 7 && afterDuplicate === registeredHere && afterOther === registeredHere + 1,
    `registered ${registeredHere}, after duplicate ${afterDuplicate}, after unrelated ${afterOther}`,
  );
} finally {
  process.chdir(repoRoot);
  await stub.close();
}

const failed = results.filter((result) => !result.passed);
process.stdout.write(
  `\nREGISTRATION: ${results.length - failed.length}/${results.length} PASS` +
    (failed.length ? ` (FAILED: ${failed.map((result) => result.name).join(", ")})\n` : "\n"),
);
// The extension keeps the session's MCP connections and the lifecycle
// heartbeat open; nothing here is waiting on them.
process.exit(failed.length ? 1 : 0);
