/**
 * oh-my-pi entry point for omp-openviking.
 *
 * The extension itself is the upstream git submodule under
 * `upstream/examples/pi-coding-agent-extension`. This file registers the
 * viking_* tools before the first await, then hands the upstream factory a
 * host that captures its later registrations.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { type ToolHost, installVikingTools } from "./adapters/tool-registration.js";
import upstreamExtension from "./upstream/examples/pi-coding-agent-extension/index.js";

export default async function (pi: ExtensionAPI) {
  // ToolHost is the structural subset of ExtensionAPI this adapter needs; the
  // casts bridge that narrow view and the host's full tool descriptor type.
  const host = installVikingTools(pi as unknown as ToolHost);
  return upstreamExtension(host as unknown as ExtensionAPI);
}
