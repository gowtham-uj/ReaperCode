/**
 * ModelCapabilitiesRegistry — feature-detect the configured model.
 *
 * Visual features (VisualInputAnalyzer, ScreenshotContextBridge, the
 * visual-analyst role) check this registry before doing real work. If
 * the model does not support image input, the visual subsystem is
 * marked "disabled" and the runtime falls back to a no-op (the
 * metadata-only analyzer path). The workflow planner sees the same
 * capability flag and routes around visual analysis.
 *
 * Capability sources, in priority order:
 *  1. explicit: caller passed `capabilities:` in the runtime options
 *  2. probe: runtime asked the model gateway for a capability list
 *  3. default: assume the unsafe minimum (no visual, tool-use yes)
 *
 * Probing is best-effort and never blocks the run. If the gateway
 * doesn't answer, the registry falls back to the default.
 */

import { DEFAULT_MODEL_CAPABILITIES, type ModelCapabilities } from "./types.js";

export { DEFAULT_MODEL_CAPABILITIES };
export type { ModelCapabilities };

export interface ModelCapabilitiesRegistryOptions {
  /** Explicit capability list. Wins over probe. */
  capabilities?: ModelCapabilities;
  /** A function that probes the model gateway for capabilities. */
  probe?: () => Promise<Partial<ModelCapabilities>>;
}

export class ModelCapabilitiesRegistry {
  private cached: ModelCapabilities;
  private readonly probeFn: (() => Promise<Partial<ModelCapabilities>>) | undefined;
  private readonly explicit: ModelCapabilities | undefined;

  constructor(opts: ModelCapabilitiesRegistryOptions = {}) {
    this.explicit = opts.capabilities;
    this.probeFn = opts.probe;
    this.cached = this.explicit ?? { ...DEFAULT_MODEL_CAPABILITIES, detectedAt: new Date().toISOString() };
  }

  /** Refresh the cached capabilities by calling the probe. */
  async refresh(): Promise<ModelCapabilities> {
    if (this.explicit) { this.cached = { ...this.explicit, detectedAt: new Date().toISOString() }; return this.cached; }
    if (!this.probeFn) return this.cached;
    try {
      const partial = await this.probeFn();
      this.cached = {
        ...this.cached,
        ...partial,
        detectedAt: new Date().toISOString(),
        source: "probe",
      };
    } catch {
      // Probing failed; keep defaults. Source stays "default".
    }
    return this.cached;
  }

  /** Get the current capabilities (cached). */
  current(): ModelCapabilities { return this.cached; }

  /** Convenience: is visual analysis supported? */
  isVisualSupported(): boolean { return this.cached.imageInput === true; }

  /** Convenience: is video analysis supported? */
  isVideoSupported(): boolean { return this.cached.videoInput === true; }

  /** Convenience: can the model call tools? */
  isToolUseSupported(): boolean { return this.cached.toolUse === true; }

  /** Convenience: can the model call multiple tools in parallel? */
  isParallelToolUseSupported(): boolean { return this.cached.parallelToolUse === true; }
}
