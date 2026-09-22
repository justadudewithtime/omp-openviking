/**
 * Factory-time tool registration for oh-my-pi.
 *
 * Upstream's tool surface is the OpenViking server's own MCP catalogue: it
 * connects an MCP client inside start(), which runs from a fire-and-forget
 * session_start handler, and registers one pi tool per listed tool. OMP has
 * already assembled the turn's tool set by then, so the session's first turn is
 * offered none of them.
 *
 * This adapter does that handshake at extension-factory time, which OMP awaits,
 * and registers the catalogue through upstream's own registerMcpTools(), so the
 * names, schemas and argument validation are upstream's and not a copy. The
 * host handed to upstream's factory then drops the duplicate registrations its
 * own bridge makes later.
 *
 * The cost is one extra MCP session per pi session: upstream still opens its
 * bridge, whose tools this adapter discards. A local handshake is a few
 * milliseconds, and the alternative (forcing `mcpEnabled: false` on upstream so
 * it skips its bridge) would make `/viking` report the tool surface as disabled
 * while it is in fact serving every call. Nothing under upstream/ is modified.
 *
 * When the handshake fails, the unwrapped host is returned: upstream retries on
 * its own schedule and the tools appear from the turn after it succeeds, which
 * is exactly the behaviour without this adapter.
 *
 * A successful bridge lives as long as the process and is deliberately never
 * closed on `session_shutdown`. It has no listening stream to keep the event
 * loop alive, and closing a Streamable HTTP transport just before the process
 * exits trips a libuv teardown assertion on Windows. Process exit is what
 * closes the socket, the same way it closes every other one.
 */
import {
  EXTENSION_VERSION,
  buildBridgeProxyConfig,
  loadConfig,
} from "../upstream/examples/pi-coding-agent-extension/config.js";
import {
  DEFAULT_HANDSHAKE_BUDGET_MS,
  createMcpBridge,
} from "../upstream/examples/pi-coding-agent-extension/lib/mcp-bridge.mjs";
import { isBypassed } from "../upstream/examples/pi-coding-agent-extension/shared/session-model.mjs";
import { registerMcpTools } from "../upstream/examples/pi-coding-agent-extension/tools.js";

/** Only the fields this adapter touches are named; the rest pass through. */
export type ToolDescriptor = Record<string, unknown> & { name: string };

/** The single host member upstream's registerMcpTools() needs. */
export interface ToolHost {
  registerTool(descriptor: ToolDescriptor): unknown;
}

/**
 * Register the OpenViking tools now, and return the host to hand to upstream's
 * factory. That host swallows the re-registration of every name registered
 * here, because a second descriptor under the same name would either be
 * rejected by pi or silently replace a working tool mid-session.
 *
 * Resolves once the MCP handshake settles, within its budget. It never throws:
 * every failure degrades to upstream's own late registration.
 */
export async function installOpenVikingTools(pi: ToolHost): Promise<ToolHost> {
  const cwd = process.cwd();
  let registered: Set<string>;
  try {
    registered = await registerCatalogue(pi, cwd);
  } catch (error) {
    // Fail soft and loud. The extension still loads and still works; only the
    // first turn's tools are lost, which is what the smoke test catches.
    console.error(
      "omp-openviking: factory-time tool registration failed, falling back to " +
        "upstream's own late registration: " +
        (error instanceof Error ? error.message : String(error)),
    );
    return pi;
  }
  if (registered.size === 0) return pi;

  return new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerTool") {
        return (descriptor: ToolDescriptor) => {
          if (typeof descriptor?.name === "string" && registered.has(descriptor.name)) {
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

/**
 * The handshake and the registration it feeds. Returns the names registered,
 * empty whenever upstream itself would register nothing: disabled extension,
 * tool surface turned off, bypassed session, or a server that did not answer.
 */
async function registerCatalogue(pi: ToolHost, cwd: string): Promise<Set<string>> {
  const config = loadConfig(cwd);
  // Each of these is a case where upstream's own factory or start() registers
  // no tool at all, so registering one here would be a behaviour change and not
  // an earlier version of the same behaviour.
  if (!config.enabled) return new Set();
  if ((config as { mcpEnabled?: boolean }).mcpEnabled === false) return new Set();
  if (isBypassed(config, { cwd })) return new Set();

  const bridge = createMcpBridge({
    // Re-read on every reconnect, the way upstream does: credentials on disk
    // can change during a session.
    readConfig: () => buildBridgeProxyConfig(loadConfig(cwd)),
    clientInfo: { name: "openviking-pi", version: EXTENSION_VERSION },
  });

  const state = await bridge.connect(DEFAULT_HANDSHAKE_BUDGET_MS);
  if (!state.connected || state.tools.length === 0) {
    // Upstream reports the failure to the user once, from its own handshake,
    // with the hint text for an unauthorized server. Saying it twice, before
    // the UI even exists, would only be noise.
    await bridge.close();
    return new Set();
  }

  // The descriptors are upstream's, bound to this bridge: the calls this
  // session makes go through the connection opened here, which is the one
  // proven to work.
  return new Set(registerMcpTools(pi, bridge));
}
