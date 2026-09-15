/**
 * Stand-in for an omp process in the lifecycle harness: loads the adapter
 * exactly like index.ts does, reports the ensureServer result, then stays
 * alive for LC_TTL_MS milliseconds (or until killed) so the heartbeat and
 * exit-time stop logic run for real.
 */
import { ensureServer } from "../adapters/server-lifecycle.ts";

const overrides = process.env.LC_OVERRIDES ? JSON.parse(process.env.LC_OVERRIDES) : {};
const result = await ensureServer(overrides);
console.log("CLIENT_READY " + result);

const ttl = Number(process.env.LC_TTL_MS || 0);
if (ttl > 0) setTimeout(() => process.exit(0), ttl);
setInterval(() => {}, 1000);
