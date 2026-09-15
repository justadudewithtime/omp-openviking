#!/usr/bin/env node
/**
 * Smoke test for the oh-my-pi port of the OpenViking extension.
 *
 * Starts the stub OpenViking API, runs OMP headless against this repository
 * three times, and asserts the three things the port has to deliver:
 *
 *   1. tool-registration : the viking_* tools exist on the turn that starts the
 *                          session, so a tool call reaches the server
 *   2. recall-injection  : the <openviking-context> block really reaches the
 *                          model (it can quote a canary back)
 *   3. capture-fidelity  : turn capture posts assistant tool parts, including
 *                          the bash tool, to /messages/batch
 *
 * Usage: node test/smoke.mjs   (or: bun run smoke)
 * Exit code 0 only when all three checks pass.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startStubServer } from "./stub-server.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "..");
const artifactsDir = join(testDir, ".artifacts");
const scratchDir = join(testDir, ".scratch");
const sessionDir = join(artifactsDir, "sessions");
const logPath = join(artifactsDir, "requests.jsonl");
const debugLogPath = resolve(artifactsDir, "extension-debug.log");

const canary = `OPENVIKING-CANARY-${randomBytes(4).toString("hex").toUpperCase()}`;

/** OMP run timeout: a real provider round trip plus tool execution. */
const RUN_TIMEOUT_MS = 240_000;
const MAX_BUFFER = 32 * 1024 * 1024;

// ------------------------------------------------------------------- utilities

function freshDir(path) {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
}

/**
 * Run OMP headless against this repository.
 *
 * `--no-extensions` disables discovery so nothing but this extension loads;
 * `-e repoRoot` loads it by directory (package.json#omp.extensions -> index.ts).
 * A scratch cwd and a scratch session dir keep every real project session out
 * of reach. `--no-session` is deliberately NOT passed: check 3 needs `-c` to
 * resume, which requires a persisted session.
 *
 * This is async on purpose. The stub API runs inside this same process, and
 * spawnSync blocks the event loop for the whole child run, so a synchronous
 * spawn would leave the child unable to reach the stub at all: every
 * OpenViking call would fail and the extension would report itself offline.
 */
function runOmp(prompt, extraArgs = []) {
  const args = [
    "-p",
    "--no-extensions",
    "-e",
    repoRoot,
    "--no-title",
    "--cwd",
    scratchDir,
    "--session-dir",
    sessionDir,
    ...extraArgs,
    prompt,
  ];

  return new Promise((resolveRun) => {
    const child = spawn("omp", args, {
      cwd: scratchDir,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENVIKING_URL: stubUrl,
        OPENVIKING_DEBUG_LOG: debugLogPath,
        PI_NO_TITLE: "1",
      },
    });

    let stdout = "";
    let stderr = "";
    let spawnError = null;
    let timedOut = false;
    let truncated = false;

    const collect = (chunk, sink) => {
      if (sink.length > MAX_BUFFER) {
        truncated = true;
        return sink;
      }
      return sink + chunk;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = collect(chunk, stdout);
    });
    child.stderr.on("data", (chunk) => {
      stderr = collect(chunk, stderr);
    });

    // `omp -p` waits for stdin to reach EOF, so close it immediately.
    child.stdin.end();

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, RUN_TIMEOUT_MS);

    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolveRun({
        status,
        stdout,
        stderr,
        error: spawnError
          ? String(spawnError.message)
          : timedOut
            ? `killed after ${RUN_TIMEOUT_MS} ms`
            : null,
        truncated,
        args,
      });
    });
  });
}

/** Parse the stub's JSONL request log, tolerating a trailing partial line. */
function readLog() {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** Requests logged since `offset` records. */
function logSince(offset) {
  return readLog().slice(offset);
}

/** Depth-first search for an object satisfying `predicate`. */
function findDeep(value, predicate, seen = new Set()) {
  if (!value || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (!Array.isArray(value) && predicate(value)) return value;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const hit = findDeep(child, predicate, seen);
    if (hit) return hit;
  }
  return null;
}

const results = [];

function report(name, passed, diagnostics) {
  results.push({ name, passed });
  process.stdout.write(`${passed ? "PASS" : "FAIL"} ${name}\n`);
  if (!passed) {
    process.stdout.write(`${diagnostics}\n`);
  }
}

function describeRun(label, run) {
  return [
    `--- ${label}`,
    `argv:   omp ${run.args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`,
    `status: ${run.status}${run.error ? ` (spawn error: ${run.error})` : ""}`,
    `stdout: ${run.stdout.trim() || "(empty)"}`,
    `stderr: ${run.stderr.trim() || "(empty)"}`,
  ].join("\n");
}

function describeRequests(label, requests) {
  const lines = requests.map(
    (r) => `  ${r.method} ${r.path}${r.body ? ` body=${JSON.stringify(r.body).slice(0, 300)}` : ""}`,
  );
  return [`--- ${label} (${requests.length} request(s))`, ...(lines.length ? lines : ["  (none)"])].join("\n");
}

// ----------------------------------------------------------------------- setup

freshDir(scratchDir);
freshDir(sessionDir);
rmSync(debugLogPath, { force: true });

const stub = await startStubServer({ logPath, canary });
const stubUrl = stub.url;

process.stdout.write(`stub on ${stubUrl}, canary ${canary}, log ${logPath}\n`);
process.stdout.write(`repo ${repoRoot}, scratch cwd ${scratchDir}\n\n`);

try {
  // --- check 1: tool registration -----------------------------------------
  // Upstream registers tools inside an async session_start chain, which OMP
  // misses. If the port works, viking_search is callable on the first turn and
  // reaches POST /api/v1/search/find.
  {
    const offset = readLog().length;
    const run = await runOmp(
      "Call the viking_search tool with the query \"project conventions\", then report its output " +
        "verbatim. Use no other tool.",
    );
    const requests = logSince(offset);
    // The automatic recall request is the one the context hook issues with
    // mode "context". /find is only ever reached from the viking_search tool,
    // and a tool-driven /search has no mode "context".
    const toolDriven = requests.filter((r) => {
      if (r.method !== "POST") return false;
      if (r.path.includes("/api/v1/search/find")) return true;
      if (r.path.includes("/api/v1/search/search")) return r.body?.mode !== "context";
      return false;
    });
    report(
      "tool-registration",
      toolDriven.length > 0,
      [describeRun("run", run), describeRequests("requests during run", requests)].join("\n"),
    );
    if (toolDriven.length) {
      process.stdout.write(`     tool-driven request: POST ${toolDriven[0].path}\n`);
    }
  }

  // --- check 2: recall injection -------------------------------------------
  // The stub returns the canary in `rendered` with an empty `digest`, so the
  // extension injects the full <openviking-context> block.
  {
    const offset = readLog().length;
    const run = await runOmp(
      "Quote verbatim, with no commentary, any canary string present in your context. " +
        "Do not use any tool.",
    );
    const hit = run.stdout.includes(canary);
    report(
      "recall-injection",
      hit,
      [
        `canary not found in stdout: ${canary}`,
        describeRun("run", run),
        describeRequests("requests during run", logSince(offset)),
      ].join("\n"),
    );
  }

  // --- check 3: capture fidelity -------------------------------------------
  // A forced bash call must show up in a /messages/batch body as an assistant
  // part with type "tool" and tool_name "bash".
  {
    const offset = readLog().length;
    const first = await runOmp("Run the bash command: echo openviking-smoke-marker");
    const second = await runOmp("Say done.", ["-c"]);
    const requests = logSince(offset);
    const batches = requests.filter((r) => r.method === "POST" && r.path.includes("/messages/batch"));

    let strategy = null;
    for (const batch of batches) {
      const structural = findDeep(
        batch.body,
        (node) => node.type === "tool" && node.tool_name === "bash",
      );
      if (structural) {
        strategy = `structural match in POST ${batch.path}: ${JSON.stringify(structural).slice(0, 200)}`;
        break;
      }
    }
    if (!strategy) {
      for (const batch of batches) {
        const raw = JSON.stringify(batch.body ?? {});
        if (raw.includes('"type":"tool"') && raw.includes("bash")) {
          strategy = `substring match in POST ${batch.path}`;
          break;
        }
      }
    }
    report(
      "capture-fidelity",
      Boolean(strategy),
      [
        `no assistant tool part with tool_name "bash" in ${batches.length} /messages/batch body(ies)`,
        describeRun("run 1 (forced bash)", first),
        describeRun("run 2 (-c continuation)", second),
        describeRequests("requests during both runs", requests),
      ].join("\n"),
    );
    if (strategy) process.stdout.write(`     ${strategy}\n`);
  }
} finally {
  await stub.close();
}

const failed = results.filter((r) => !r.passed);
process.stdout.write(
  `\nSMOKE: ${results.length - failed.length}/${results.length} PASS` +
    (failed.length ? ` (FAILED: ${failed.map((r) => r.name).join(", ")})\n` : "\n"),
);
process.exit(failed.length ? 1 : 0);
