/**
 * oh-my-pi entry point for omp-openviking.
 *
 * The extension itself is the upstream git submodule under
 * `upstream/examples/pi-coding-agent-extension`. This file makes sure the
 * OpenViking server is running (starting it once across all omp processes when
 * needed), registers the server's MCP tool catalogue before the first turn is
 * assembled, then hands the upstream factory a host that drops the duplicate
 * registrations its own bridge makes later.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { type ToolHost, installOpenVikingTools } from "./adapters/tool-registration.js";
import { ensureServer } from "./adapters/server-lifecycle.js";
import upstreamExtension from "./upstream/examples/pi-coding-agent-extension/index.js";

export default async function (pi: ExtensionAPI) {
  // First, because the tool catalogue is the server's: nothing can be listed
  // until something answers. Bounded by OPENVIKING_AUTOSTART_TIMEOUT_MS;
  // degrades, never throws.
  await ensureServer();
  // ToolHost is the structural subset of ExtensionAPI this adapter needs; the
  // casts bridge that narrow view and the host's full tool descriptor type.
  const host = await installOpenVikingTools(pi as unknown as ToolHost);
  return upstreamExtension(host as unknown as ExtensionAPI);
}
