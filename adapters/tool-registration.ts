/**
 * Factory-time tool registration for oh-my-pi.
 *
 * Upstream registers its viking_* tools inside start(), which runs after an
 * async health check in a fire-and-forget session_start handler. OMP has
 * already assembled the turn's tool set by then, so none of the tools are
 * offered to the model on the turn that starts the session.
 *
 * This adapter registers upstream's own descriptors synchronously, at
 * extension-factory time, and delegates each execute to the descriptor
 * upstream registers later with its real client and sync manager. Until that
 * happens, a call reports the server as unreachable instead of the tool being
 * absent. Nothing under upstream/ is modified, so the submodule stays pristine.
 */
import { fileURLToPath } from "node:url";

import type { OVClient } from "../upstream/examples/pi-coding-agent-extension/client.js";
import { loadConfig } from "../upstream/examples/pi-coding-agent-extension/config.js";
import type { SyncManager } from "../upstream/examples/pi-coding-agent-extension/sync.js";
import { registerTools } from "../upstream/examples/pi-coding-agent-extension/tools.js";

const EXTENSION_DIR = fileURLToPath(
  new URL("../upstream/examples/pi-coding-agent-extension/", import.meta.url),
);

const VIKING_PREFIX = "viking_";

/** Upstream tool executes take (toolCallId, params, signal, onUpdate, ctx). */
type ToolExecute = (...args: unknown[]) => Promise<unknown>;

/** Only the fields this adapter touches are named; the rest pass through. */
export type ToolDescriptor = Record<string, unknown> & { name: string; execute: ToolExecute };

/** The single host member upstream's registerTools() needs. */
export interface ToolHost {
  registerTool(descriptor: ToolDescriptor): unknown;
}

/** Result returned for any viking_* call made before the server is reachable. */
function unreachable(endpoint: string) {
  return {
    content: [
      {
        type: "text",
        text:
          `OpenViking server not reachable at ${endpoint}. ` +
          `Start openviking-server, or point OPENVIKING_URL at the right ` +
          `address, then retry. No OpenViking data was read or written.`,
      },
    ],
    isError: true,
  };
}

/**
 * Register the viking_* tools now, and return the host to hand to upstream's
 * factory. The returned proxy captures upstream's later registrations instead
 * of forwarding them, because the names are already registered here.
 */
export function installVikingTools(pi: ToolHost): ToolHost {
  const config = loadConfig(EXTENSION_DIR);
  // Upstream's factory returns immediately when disabled; register nothing.
  if (!config.enabled) return pi;

  /** Upstream's real descriptors, keyed by tool name, once it registers them. */
  const live = new Map<string, ToolDescriptor>();

  const harvested: ToolDescriptor[] = [];
  try {
    registerTools(
      { registerTool: (descriptor: ToolDescriptor) => harvested.push(descriptor) },
      {} as unknown as OVClient,
      {} as unknown as SyncManager,
    );
  } catch (error) {
    // Fail soft and loud: hand back the unwrapped host so upstream registers
    // its tools the way it always did (late, so they appear from the second
    // turn on) rather than the extension failing to load outright. The smoke
    // test still fails, which is how a maintainer finds out.
    console.error(
      "omp-openviking: could not harvest upstream tool descriptors, falling back to " +
        "upstream's own late registration: " +
        (error instanceof Error ? error.message : String(error)),
    );
    return pi;
  }

  for (const descriptor of harvested) {
    pi.registerTool({
      ...descriptor,
      async execute(...args: unknown[]) {
        const real = live.get(descriptor.name);
        if (!real) return unreachable(config.endpoint);
        return real.execute.apply(real, args);
      },
    });
  }

  return new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerTool") {
        return (descriptor: ToolDescriptor) => {
          if (typeof descriptor?.name === "string" && descriptor.name.startsWith(VIKING_PREFIX)) {
            live.set(descriptor.name, descriptor);
            return undefined;
          }
          return target.registerTool(descriptor);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
