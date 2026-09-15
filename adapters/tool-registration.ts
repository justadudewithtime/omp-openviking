/**
 * Factory-time tool registration adapter for oh-my-pi.
 *
 * Upstream registers its viking_* tools inside start(), which runs after an
 * async health check in a fire-and-forget session_start handler. oh-my-pi has
 * already assembled the turn's tool set by then, so none of the tools are
 * offered to the model on the turn that triggered startup.
 *
 * This adapter registers the same upstream tool set synchronously, at
 * extension-factory time, and wraps every execute with a connectivity guard.
 * Registration therefore no longer depends on the health check completing;
 * only the tool's behavior does. Once connected the wrapper is transparent and
 * upstream's execute runs unchanged.
 */
import { registerTools } from "../upstream/tools.js";
import type { OVClient } from "../upstream/client.js";
import type { SyncManager } from "../upstream/sync.js";

/** Upstream tool executes take (toolCallId, params, signal, onUpdate, ctx). */
type ToolExecute = (...args: unknown[]) => Promise<unknown>;

/** Only the fields this adapter touches are named; the rest pass through. */
type ToolDescriptor = Record<string, unknown> & { execute: ToolExecute };

/** The single host member upstream's registerTools() needs. */
interface ToolHost {
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
 * Register upstream's tools now, guarded by `isConnected`.
 *
 * @param pi           the host ExtensionAPI
 * @param client       upstream OpenViking client (owns cfg.endpoint)
 * @param sync         upstream sync manager, passed through untouched
 * @param isConnected  read at call time, never at registration time
 */
export function registerToolsEagerly(
  pi: ToolHost,
  client: OVClient,
  sync: SyncManager | undefined,
  isConnected: () => boolean,
): void {
  // Proxy the host so upstream's registerTools() sees a normal ExtensionAPI and
  // every other member keeps working, while registerTool is intercepted.
  const host = new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerTool") {
        return (descriptor: ToolDescriptor) => {
          const upstreamExecute = descriptor.execute;
          return target.registerTool({
            ...descriptor,
            async execute(...args: unknown[]) {
              if (!isConnected()) return unreachable(client.cfg.endpoint);
              return upstreamExecute.apply(descriptor, args);
            },
          });
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  registerTools(host, client, sync);
}
