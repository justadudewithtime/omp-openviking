/**
 * OpenViking server lifecycle for oh-my-pi.
 *
 * Upstream's extension health-checks the server once at session start and
 * degrades if it is down; nothing starts it. This adapter makes the server
 * automatic across any number of concurrent omp processes:
 *
 * - At extension load, GET /health and require an OpenViking identity
 *   (status "ok" plus a version field). Up: adopt it and do nothing more.
 * - Down: an exclusive-create lock file (per endpoint, in the temp dir) elects
 *   exactly one process to spawn `openviking-server` detached; the others poll
 *   health until it is ready. One server total, no matter how many omp
 *   processes, subagents, or one-shot `omp -p` runs start at the same moment.
 * - Every omp process heartbeats a marker file every 10 s. At process exit
 *   the last one standing (no other fresh marker) stops the server, but only
 *   if a server record proves a plugin process started it. Manually
 *   started and Docker servers are never touched.
 * - The stop path verifies the recorded pid's StartTime via PowerShell before
 *   killing, so a reused pid is never terminated by mistake, and uses
 *   taskkill /T so the server's own children (vikingbot) die with it.
 *
 * Failure mode everywhere is conservative: when in doubt, the server is left
 * running and the extension falls back to the unreachable guard from
 * tool-registration.ts.
 *
 * Escape hatches: OPENVIKING_NO_AUTOSTART=1, OPENVIKING_NO_AUTOSTOP=1,
 * OPENVIKING_AUTOSTART_TIMEOUT_MS (default 30000; a healthy local server
 * answers in well under 10 s, and this delay is paid at extension load).
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_DIR = fileURLToPath(
  new URL("../upstream/examples/pi-coding-agent-extension/", import.meta.url),
);

const DEFAULT_ENDPOINT = "http://127.0.0.1:1933";

/**
 * The two fields lifecycle needs from the extension's config.json, without
 * importing upstream's config.ts (its `./x.js` -> `x.ts` specifiers only
 * resolve inside the omp loader, and this module must also load under plain
 * Node for the test harness). Env precedence mirrors upstream:
 * OPENVIKING_URL, then OPENVIKING_BASE_URL, then the file, then the default.
 */
function readLifecycleConfig(): { enabled: boolean; endpoint: string } {
  let file: { enabled?: boolean; endpoint?: string } = {};
  try {
    file = JSON.parse(readFileSync(join(EXTENSION_DIR, "config.json"), "utf8")) as typeof file;
  } catch {
    // Missing or malformed config.json: upstream defaults apply.
  }
  return {
    enabled: file.enabled ?? true,
    endpoint:
      process.env.OPENVIKING_URL ??
      process.env.OPENVIKING_BASE_URL ??
      file.endpoint ??
      DEFAULT_ENDPOINT,
  };
}

const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_FRESH_MS = 25_000;
const LOCK_STALE_MS = 120_000;
const HEALTH_POLL_MS = 500;
const START_TIME_TOLERANCE_MS = 15_000;

export interface LifecycleOverrides {
  /** Effective server endpoint; defaults to upstream config + OPENVIKING_URL. */
  endpoint?: string;
  /** Spawn command as argv; default ["openviking-server"]. */
  serverCmd?: string[];
  /** Spawn/readiness budget in ms; default 30000 or OPENVIKING_AUTOSTART_TIMEOUT_MS. */
  timeoutMs?: number;
  autostart?: boolean;
  autostop?: boolean;
}

export type EnsureResult = "adopted" | "started" | "unavailable" | "skipped";

interface ServerRecord {
  pid: number;
  startedAt: number;
  endpoint: string;
}

/**
 * Coordination state for one endpoint: spawn lock, client heartbeats, the
 * plugin-started server record, and the spawned server's log. Exported for
 * the lifecycle test harness.
 */
export function lifecycleStateDir(endpoint: string): string {
  const key = createHash("sha1").update(endpoint).digest("hex").slice(0, 10);
  return join(tmpdir(), `omp-openviking-${key}`);
}

function debugLog(stage: string, data: Record<string, unknown>): void {
  const target = process.env.OPENVIKING_DEBUG_LOG;
  if (!target) return;
  try {
    appendFileSync(
      target,
      JSON.stringify({ ts: new Date().toISOString(), hook: "lifecycle", stage, data }) + "\n",
    );
  } catch {
    // Debug logging never breaks lifecycle.
  }
}

/** An OpenViking health answer carries both status ok and a version string. */
function isOpenVikingHealth(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as Record<string, unknown>).status === "ok" &&
    typeof (body as Record<string, unknown>).version === "string"
  );
}

async function checkHealth(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/health`, {
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) return false;
    return isOpenVikingHealth(await response.json());
  } catch {
    return false;
  }
}

/** Synchronous health check for the process-exit path (curl is OS-bundled). */
function checkHealthSync(endpoint: string): boolean {
  try {
    const out = execFileSync("curl", ["-sS", "-m", "3", `${endpoint}/health`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    return isOpenVikingHealth(JSON.parse(out));
  } catch {
    return false;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function ensureServer(overrides: LifecycleOverrides = {}): Promise<EnsureResult> {
  try {
    return await ensureServerInner(overrides);
  } catch (error) {
    debugLog("error", { message: error instanceof Error ? error.message : String(error) });
    return "unavailable";
  }
}

let hooksRegistered = false;

async function ensureServerInner(overrides: LifecycleOverrides): Promise<EnsureResult> {
  const config = readLifecycleConfig();
  if (!config.enabled) return "skipped";

  const endpoint = (overrides.endpoint ?? config.endpoint).replace(/\/+$/, "");
  const autostart =
    overrides.autostart ?? process.env.OPENVIKING_NO_AUTOSTART !== "1";
  const timeoutMs =
    overrides.timeoutMs ??
    Number(process.env.OPENVIKING_AUTOSTART_TIMEOUT_MS ?? 30_000);
  const serverCmd = overrides.serverCmd ?? ["openviking-server"];

  const dir = lifecycleStateDir(endpoint);
  mkdirSync(join(dir, "clients"), { recursive: true });
  registerProcessHooks(dir, endpoint, overrides.autostop);

  if (await checkHealth(endpoint)) {
    debugLog("adopted", { endpoint });
    return "adopted";
  }
  if (!autostart) return "unavailable";

  const deadline = Date.now() + timeoutMs;
  const lockFile = join(dir, "start.lock");
  if (acquireStartLock(lockFile)) {
    try {
      // Re-check inside the lock: the previous holder may just have won.
      if (await checkHealth(endpoint)) return "adopted";
      const spawnedAt = Date.now();
      const child = spawnServer(serverCmd, dir);
      if (child === undefined) return "unavailable";
      if (await waitHealthy(endpoint, deadline)) {
        writeFileSync(
          join(dir, "server.json"),
          JSON.stringify({ pid: child, startedAt: spawnedAt, endpoint } satisfies ServerRecord),
        );
        debugLog("started", { endpoint, pid: child });
        return "started";
      }
      // Our own child never answered: do not leave an orphan behind.
      debugLog("start-timeout", { endpoint, pid: child, timeoutMs });
      killTree(child);
      return "unavailable";
    } finally {
      rmSync(lockFile, { force: true });
    }
  }

  // Another omp process is starting the server; wait for it.
  const ok = await waitHealthy(endpoint, deadline);
  debugLog(ok ? "waited" : "wait-timeout", { endpoint, timeoutMs });
  return ok ? "adopted" : "unavailable";
}

/**
 * Atomic exclusive-create file lock. The holder identity is the file content,
 * so there is no window where the lock exists without an owner: an O_EXCL
 * create either wins outright or fails.
 *
 * A lock is stolen only when it is provably abandoned: the holder pid is dead,
 * or the lock is older than LOCK_STALE_MS. A lock that is young but not yet
 * readable (the winner's write has not landed) is treated as held, which is
 * what keeps two processes from both spawning a server.
 */
function acquireStartLock(lockFile: string): boolean {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }), {
        flag: "wx",
      });
      return true;
    } catch {
      // EEXIST: somebody holds it. Decide whether it is abandoned.
    }

    let age: number;
    try {
      age = Date.now() - statSync(lockFile).mtimeMs;
    } catch {
      continue; // Lock released between our create and our stat; try again.
    }

    try {
      const holder = JSON.parse(readFileSync(lockFile, "utf8")) as { pid?: number; at?: number };
      const alive = typeof holder.pid === "number" && pidAlive(holder.pid);
      if (alive && age < LOCK_STALE_MS) return false;
    } catch {
      // Empty or corrupt: a write in flight if young, junk if old.
      if (age < LOCK_STALE_MS) return false;
    }

    debugLog("lock-steal", { lockFile, ageMs: age });
    rmSync(lockFile, { force: true });
  }
  return false;
}

/** Spawn detached so the server outlives this process; returns the pid. */
function spawnServer(serverCmd: string[], dir: string): number | undefined {
  try {
    const logFd = openSync(join(dir, "server.log"), "a");
    const child = spawn(serverCmd[0], serverCmd.slice(1), {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
    });
    closeSync(logFd);
    child.unref();
    child.on("error", (error) => debugLog("spawn-error", { cmd: serverCmd[0], message: error.message }));
    return child.pid ?? undefined;
  } catch (error) {
    debugLog("spawn-failed", {
      cmd: serverCmd.join(" "),
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

async function waitHealthy(endpoint: string, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    if (await checkHealth(endpoint)) return true;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, HEALTH_POLL_MS);
    await promise;
  }
  return checkHealth(endpoint);
}

function registerProcessHooks(dir: string, endpoint: string, autostopOverride?: boolean): void {
  if (hooksRegistered) return;
  hooksRegistered = true;

  const clientsDir = join(dir, "clients");
  const ownMarker = join(clientsDir, `${process.pid}.json`);
  const beat = () => {
    try {
      writeFileSync(ownMarker, JSON.stringify({ pid: process.pid, at: Date.now() }));
    } catch {
      // Marker loss only makes shutdown more conservative.
    }
  };
  beat();
  setInterval(beat, HEARTBEAT_INTERVAL_MS).unref();

  process.on("exit", () => {
    try {
      unlinkSync(ownMarker);
    } catch {
      // Already gone.
    }
    const autostop = autostopOverride ?? process.env.OPENVIKING_NO_AUTOSTOP !== "1";
    if (autostop) stopServerIfLast(dir, endpoint);
  });
}

/**
 * Sync, exit-time shutdown. Every branch that cannot prove the running server
 * is the one a plugin process started leaves it alone.
 */
function stopServerIfLast(dir: string, endpoint: string): void {
  const serverFile = join(dir, "server.json");
  let record: ServerRecord;
  try {
    record = JSON.parse(readFileSync(serverFile, "utf8")) as ServerRecord;
  } catch {
    return; // Nobody started it from a plugin process.
  }

  // Another omp process with a fresh heartbeat is still around: not last.
  try {
    const now = Date.now();
    for (const name of readdirSync(join(dir, "clients"))) {
      if (name === `${process.pid}.json`) continue;
      try {
        if (now - statSync(join(dir, "clients", name)).mtimeMs < HEARTBEAT_FRESH_MS) return;
      } catch {
        // Marker vanished mid-scan; that process is exiting anyway.
      }
    }
  } catch {
    return;
  }

  if (!checkHealthSync(endpoint)) {
    rmSync(serverFile, { force: true }); // Already dead; just clean up.
    return;
  }

  if (!pidIdentityMatches(record)) {
    // Cannot prove the pid is still our server; never kill a stranger.
    rmSync(serverFile, { force: true });
    return;
  }

  killTree(record.pid);
  debugLog("stopped", { endpoint, pid: record.pid });
  rmSync(serverFile, { force: true });
}

/**
 * Terminate a process and its children. On Windows the server shim spawns a
 * python child (vikingbot), so /T is required or the port stays bound.
 */
function killTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 10_000,
      });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch (error) {
    debugLog("kill-failed", { pid, message: error instanceof Error ? error.message : "?" });
  }
}

/** Verify the recorded pid is the process we spawned by comparing StartTime. */
function pidIdentityMatches(record: ServerRecord): boolean {
  if (!pidAlive(record.pid)) return false;
  if (process.platform !== "win32") return true; // pid + health check suffices there
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${record.pid} -ErrorAction Stop).StartTime.ToString('o')`,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 },
    );
    const startTime = Date.parse(out.trim());
    if (Number.isNaN(startTime)) return false;
    return Math.abs(startTime - record.startedAt) < START_TIME_TOLERANCE_MS;
  } catch {
    return false;
  }
}
