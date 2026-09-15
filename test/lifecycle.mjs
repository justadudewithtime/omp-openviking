/**
 * Lifecycle drive harness: proves the server autostart/autostop contract with
 * real processes against a fake OpenViking server on port 2933 (the real
 * server on 1933 is never touched; coordination state is keyed by endpoint).
 *
 *   node test/lifecycle.mjs
 *
 * Scenarios:
 *   A  cold start: first client spawns the server, last exit stops it (tree)
 *   B  manual server is adopted, never stopped
 *   C  four concurrent clients spawn exactly one server
 *   D  server survives the first of two clients exiting, stops with the last
 *   E  a start lock held by a dead pid is stolen
 *   F  a pid in server.json that fails the StartTime identity check is spared
 *   G  OPENVIKING_NO_AUTOSTART / autostop:false are honored
 *   H  a young unreadable lock is respected (regression: double spawn)
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { lifecycleStateDir } from "../adapters/server-lifecycle.ts";

const ENDPOINT = "http://127.0.0.1:2933";
const DIR = lifecycleStateDir(ENDPOINT);
const FAKE_SERVER = join(import.meta.dirname, "fake-server.mjs");
const FAKE_CLIENT = join(import.meta.dirname, "fake-client.mjs");

let passed = 0;
let failed = 0;
function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${detail ? ` (${detail})` : ""}`);
  }
}

const strayPids = new Set();
function killTree(pid) {
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    // Already dead.
  }
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function serverUp() {
  try {
    const res = await fetch(`${ENDPOINT}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}
function sleep(ms) {
  const { promise, resolve } = Promise.withResolvers();
  setTimeout(resolve, ms);
  return promise;
}
async function waitFor(condition, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await sleep(100);
  }
  console.log(`  (waitFor timed out: ${label})`);
  return false;
}
function serverRecord() {
  try {
    return JSON.parse(readFileSync(join(DIR, "server.json"), "utf8"));
  } catch {
    return undefined;
  }
}

function resetState() {
  rmSync(DIR, { recursive: true, force: true });
}

/** Spawn a fake omp client; resolves { result } once it reports ready. */
function runClient({ ttlMs = 1500, overrides = {}, env = {} } = {}) {
  const merged = { endpoint: ENDPOINT, timeoutMs: 20_000, ...overrides };
  const proc = spawn(process.execPath, [FAKE_CLIENT], {
    env: {
      ...process.env,
      LC_OVERRIDES: JSON.stringify(merged),
      LC_TTL_MS: String(ttlMs),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  proc.stderr.on("data", (chunk) => (stderr += chunk));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`client did not report ready; stderr: ${stderr.slice(0, 400)}`)),
      30_000,
    );
    proc.stdout.on("data", (chunk) => {
      const text = String(chunk);
      if (text.includes("CLIENT_READY")) {
        clearTimeout(timer);
        resolve(text.split("CLIENT_READY")[1].trim().split(/\s/)[0]);
      }
    });
  });
  const exited = new Promise((resolve) => proc.on("exit", resolve));
  return { proc, ready, exited };
}

async function scenarioA() {
  console.log("\n== A: cold start, last exit stops the tree");
  resetState();
  const client = runClient({
    ttlMs: 1500,
    overrides: { serverCmd: [process.execPath, FAKE_SERVER] },
  });
  check("A1 client started the server", (await client.ready) === "started");
  check("A2 health is up", await waitFor(serverUp, 5000, "A2"));
  const record = serverRecord();
  check("A3 server.json written with live pid", record?.pid > 0 && pidAlive(record.pid));
  const log = existsSync(join(DIR, "server.log"))
    ? readFileSync(join(DIR, "server.log"), "utf8")
    : "";
  const childPid = Number(/FAKE_CHILD (\d+)/.exec(log)?.[1]);
  check("A4 fake server child exists", childPid > 0 && pidAlive(childPid));
  await client.exited;
  check("A5 server stopped after last exit", await waitFor(async () => !(await serverUp()), 8000, "A5"));
  check("A6 server.json cleaned up", serverRecord() === undefined);
  check("A7 server child died with it", !pidAlive(childPid));
}

async function scenarioB() {
  console.log("\n== B: manually started server is adopted, never stopped");
  resetState();
  const manual = spawn(process.execPath, [FAKE_SERVER], { stdio: ["ignore", "pipe", "ignore"] });
  strayPids.add(manual.pid);
  await waitFor(serverUp, 5000, "B up");
  const client = runClient({ ttlMs: 1200 });
  check("B1 client adopted", (await client.ready) === "adopted");
  await client.exited;
  await sleep(500);
  check("B2 manual server still alive", pidAlive(manual.pid) && (await serverUp()));
  check("B3 no server.json for a manual server", serverRecord() === undefined);
  killTree(manual.pid);
  strayPids.delete(manual.pid);
}

async function scenarioC() {
  console.log("\n== C: six concurrent clients spawn exactly one server");
  resetState();
  const clients = Array.from({ length: 6 }, () =>
    runClient({ ttlMs: 3500, overrides: { serverCmd: [process.execPath, FAKE_SERVER] } }),
  );
  const results = await Promise.all(clients.map((client) => client.ready));
  check(
    "C1 exactly one spawner",
    results.filter((result) => result === "started").length === 1,
    results.join(","),
  );
  check(
    "C2 everyone connected",
    results.every((result) => result === "started" || result === "adopted"),
    results.join(","),
  );
  await Promise.all(clients.map((client) => client.exited));
  const log = readFileSync(join(DIR, "server.log"), "utf8");
  check(
    "C3 exactly one fake server process",
    (log.match(/FAKE_UP/g) || []).length === 1,
  );
  check("C4 server stopped after the last exit", await waitFor(async () => !(await serverUp()), 8000, "C4"));
}

async function scenarioD() {
  console.log("\n== D: server survives the first of two exits");
  resetState();
  const first = runClient({ ttlMs: 4000, overrides: { serverCmd: [process.execPath, FAKE_SERVER] } });
  const second = runClient({ ttlMs: 1500, overrides: { serverCmd: [process.execPath, FAKE_SERVER] } });
  await Promise.all([first.ready, second.ready]);
  await second.exited;
  check("D1 server alive after first exit", await serverUp());
  await first.exited;
  check("D2 server stopped after last exit", await waitFor(async () => !(await serverUp()), 8000, "D2"));
}

async function scenarioE() {
  console.log("\n== E: lock held by a dead pid is stolen");
  resetState();
  mkdirSync(join(DIR, "clients"), { recursive: true });
  writeFileSync(join(DIR, "start.lock"), JSON.stringify({ pid: 999999, at: Date.now() }));
  const client = runClient({ ttlMs: 1200, overrides: { serverCmd: [process.execPath, FAKE_SERVER] } });
  check("E1 client stole lock and started", (await client.ready) === "started");
  await client.exited;
  await waitFor(async () => !(await serverUp()), 8000, "E cleanup");
}

async function scenarioH() {
  console.log("\n== H: young unreadable lock is respected, never stolen");
  resetState();
  mkdirSync(join(DIR, "clients"), { recursive: true });
  // Exactly what a winner's lock looks like microseconds before its write
  // lands. Stealing this is how two servers got spawned.
  writeFileSync(join(DIR, "start.lock"), "");
  const client = runClient({
    ttlMs: 500,
    overrides: { serverCmd: [process.execPath, FAKE_SERVER], timeoutMs: 2500 },
  });
  check("H1 client waited instead of spawning", (await client.ready) === "unavailable");
  check("H2 no server spawned", !(await serverUp()));
  check("H3 no server.json", serverRecord() === undefined);
  await client.exited;
}

async function scenarioF() {
  console.log("\n== F: pid failing identity check is spared");
  resetState();
  const manual = spawn(process.execPath, [FAKE_SERVER], { stdio: ["ignore", "pipe", "ignore"] });
  strayPids.add(manual.pid);
  await waitFor(serverUp, 5000, "F up");
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  strayPids.add(sleeper.pid);
  mkdirSync(join(DIR, "clients"), { recursive: true });
  writeFileSync(
    join(DIR, "server.json"),
    JSON.stringify({ pid: sleeper.pid, startedAt: Date.now() - 3_600_000, endpoint: ENDPOINT }),
  );
  const client = runClient({ ttlMs: 1200 });
  check("F1 client adopted", (await client.ready) === "adopted");
  await client.exited;
  await sleep(500);
  check("F2 innocent pid not killed", pidAlive(sleeper.pid));
  check("F3 unprovable server.json removed", serverRecord() === undefined);
  killTree(manual.pid);
  killTree(sleeper.pid);
  strayPids.delete(manual.pid);
  strayPids.delete(sleeper.pid);
}

async function scenarioG() {
  console.log("\n== G: autostart/autostop switches");
  resetState();
  const noStart = runClient({ ttlMs: 1000, overrides: { autostart: false } });
  check("G1 NO_AUTOSTART reports unavailable", (await noStart.ready) === "unavailable");
  check("G2 nothing spawned", !(await serverUp()) && serverRecord() === undefined);
  await noStart.exited;

  const noStop = runClient({
    ttlMs: 1200,
    overrides: { serverCmd: [process.execPath, FAKE_SERVER], autostop: false },
  });
  check("G3 autostop off still starts", (await noStop.ready) === "started");
  await noStop.exited;
  await sleep(500);
  check("G4 server left running", await serverUp());
  const record = serverRecord();
  if (record?.pid) killTree(record.pid);
}

const scenarios = {
  A: scenarioA,
  B: scenarioB,
  C: scenarioC,
  D: scenarioD,
  E: scenarioE,
  F: scenarioF,
  G: scenarioG,
  H: scenarioH,
};
const only = process.argv[2]?.toUpperCase();
try {
  for (const [name, fn] of Object.entries(scenarios)) {
    if (only && name !== only) continue;
    await fn();
  }
} finally {
  for (const pid of strayPids) killTree(pid);
  if (serverRecord()?.pid) killTree(serverRecord().pid);
  resetState();
}

console.log(`\nLIFECYCLE: ${passed}/${passed + failed} PASS`);
console.log(`(state dir: ${DIR})`);
process.exit(failed === 0 ? 0 : 1);
