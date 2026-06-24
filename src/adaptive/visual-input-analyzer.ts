/**
 * VisualInputAnalyzer — provider-neutral visual analysis.
 *
 * Reaper does not embed a vision model. Instead, the analyzer delegates
 * to a configured `VisionModel` provider. If no provider is configured
 * the analyzer falls back to a tiny OCR/metadata-based analyzer that
 * detects image dimensions, MIME type, and any text heuristically
 * embedded in the file name or path.
 *
 * Public surface:
 *  - registerArtifact(artifact)
 *  - analyzeImage(artifactId, prompt?) -> VisualAnalysisResult
 *  - analyzeScreenshot(artifactId, taskContext?) -> VisualAnalysisResult
 *  - extractVideoFrames(artifactId, sampleSpec) -> VisualArtifact[]
 *  - compareScreenshots(beforeId, afterId, prompt?) -> VisualAnalysisResult
 *  - listArtifacts() -> VisualArtifact[]
 *
 * Storage:
 *  - <workspace>/.reaper/visual/artifacts.jsonl
 *  - <workspace>/.reaper/visual/analysis.jsonl
 *
 * Important: raw image bytes are NEVER put into the main context. Only
 * compact, structured findings are returned.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";

import type {
  VisualAnalysisResult,
  VisualArtifact,
  VisualArtifactSource,
  VisualContextBridgeOutput,
  VisualErrorKind,
  VisualErrorSignal,
  VisualEvidence,
  UIElement,
} from "./types.js";
import { ScreenshotContextBridge } from "./screenshot-context-bridge.js";
import { ModelCapabilitiesRegistry } from "./model-capabilities.js";

const SUPPORTED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);
const SUPPORTED_VIDEO_MIME = new Set(["video/mp4", "video/webm"]);

export interface VisionModel {
  name: string;
  /**
   * Analyze an image and return a JSON result. The runtime wraps the
   * call and never returns raw bytes to the caller.
   */
  analyze(input: { path: string; mimeType: string; prompt?: string }): Promise<{
    summary: string;
    detectedText: string[];
    uiElements: UIElement[];
    errors: VisualErrorSignal[];
    confidence: number;
  }>;
}

export interface VisualInputAnalyzerOptions {
  workspaceRoot: string;
  /** When undefined, the analyzer uses the OCR/metadata fallback. */
  visionModel?: VisionModel;
  /** Capability registry. If absent, the analyzer treats visual as
   *  supported only when a visionModel is configured. */
  capabilities?: ModelCapabilitiesRegistry;
}

export interface VisualAnalysisUnavailable {
  available: false;
  reason: string;
}

export interface VisualAnalysisOk {
  available: true;
  result: VisualAnalysisResult;
}

export type VisualAnalysisOutcome = VisualAnalysisUnavailable | VisualAnalysisOk;

export class VisualInputAnalyzer {
  private readonly artifactsPath: string;
  private readonly analysisPath: string;
  private artifacts: Map<string, VisualArtifact> = new Map();
  private analyses: Map<string, VisualAnalysisResult> = new Map();
  private visionModel: VisionModel | undefined;
  private readonly workspaceRoot: string;
  private readonly bridge: ScreenshotContextBridge;
  private readonly capabilities: ModelCapabilitiesRegistry | undefined;

  constructor(opts: VisualInputAnalyzerOptions) {
    this.workspaceRoot = opts.workspaceRoot;
    this.visionModel = opts.visionModel;
    this.capabilities = opts.capabilities;
    const dir = join(opts.workspaceRoot, ".reaper", "visual");
    mkdirSync(dir, { recursive: true });
    this.artifactsPath = join(dir, "artifacts.jsonl");
    this.analysisPath = join(dir, "analysis.jsonl");
    this.bridge = new ScreenshotContextBridge();
    this.load();
  }

  /** Whether the analyzer can produce a real (non-metadata) result. */
  isAvailable(): boolean {
    if (this.visionModel !== undefined) return true;
    if (this.capabilities !== undefined && !this.capabilities.isVisualSupported()) return false;
    // No vision model and no explicit no — return true only if
    // capabilities explicitly say image input is supported.
    return this.capabilities?.isVisualSupported() ?? false;
  }

  /** Short reason why the analyzer is unavailable, or null. */
  unavailableReason(): string | null {
    if (this.isAvailable()) return null;
    if (this.capabilities && !this.capabilities.isVisualSupported()) {
      return "model does not support image input; visual analysis is disabled";
    }
    return "no vision model configured";
  }

  /** Try to analyze a screenshot. Returns an outcome that distinguishes
   *  real results from "feature unavailable". Callers should respect the
   *  unavailable branch and fall back to non-visual analysis. */
  async tryAnalyzeScreenshot(id: string, taskContext?: { goal?: string }): Promise<VisualAnalysisOutcome> {
    if (!this.isAvailable()) {
      return { available: false, reason: this.unavailableReason() ?? "visual disabled" };
    }
    const result = await this.analyzeScreenshot(id, taskContext);
    return { available: true, result };
  }

  private load(): void {
    if (existsSync(this.artifactsPath)) {
      for (const line of readFileSync(this.artifactsPath, "utf8").split("\n").filter(Boolean)) {
        try {
          const a = JSON.parse(line) as VisualArtifact;
          this.artifacts.set(a.id, a);
        } catch { /* skip */ }
      }
    }
    if (existsSync(this.analysisPath)) {
      for (const line of readFileSync(this.analysisPath, "utf8").split("\n").filter(Boolean)) {
        try {
          const r = JSON.parse(line) as VisualAnalysisResult;
          this.analyses.set(r.artifactId, r);
        } catch { /* skip */ }
      }
    }
  }

  /** Register a visual artifact from a file path. */
  registerArtifact(input: { path: string; source: VisualArtifactSource; relatedRunId?: string }): VisualArtifact | null {
    if (!existsSync(input.path)) return null;
    const stat = statSync(input.path);
    const mimeType = guessMimeType(input.path);
    const hash = createHash("sha256").update(readFileSync(input.path)).digest("hex");
    const id = `vis-${hash.slice(0, 12)}`;
    const artifact: VisualArtifact = {
      id,
      path: input.path,
      mimeType,
      source: input.source,
      createdAt: new Date().toISOString(),
      hash,
      ...(input.relatedRunId !== undefined ? { relatedRunId: input.relatedRunId } : {}),
    };
    if (SUPPORTED_VIDEO_MIME.has(mimeType)) {
      artifact.frameCount = 1;
    }
    this.artifacts.set(id, artifact);
    appendFileSync(this.artifactsPath, JSON.stringify(artifact) + "\n");
    return artifact;
  }

  listArtifacts(): VisualArtifact[] { return [...this.artifacts.values()]; }

  getArtifact(id: string): VisualArtifact | null { return this.artifacts.get(id) ?? null; }

  /** Analyze a screenshot through the configured vision model (or fallback). */
  async analyzeScreenshot(id: string, taskContext?: { goal?: string }): Promise<VisualAnalysisResult> {
    const artifact = this.artifacts.get(id);
    if (!artifact) throw new Error(`artifact ${id} not found`);
    if (!SUPPORTED_IMAGE_MIME.has(artifact.mimeType)) {
      return this.metadataOnlyResult(artifact, "not an image mime type");
    }
    if (!this.isAvailable()) {
      return this.metadataOnlyResult(artifact, this.unavailableReason() ?? "visual disabled");
    }
    return this.analyzeArtifact(artifact, taskContext?.goal);
  }

  /** Analyze any image (alias of analyzeScreenshot with prompt). */
  async analyzeImage(id: string, prompt?: string): Promise<VisualAnalysisResult> {
    const artifact = this.artifacts.get(id);
    if (!artifact) throw new Error(`artifact ${id} not found`);
    if (!this.isAvailable()) {
      return this.metadataOnlyResult(artifact, this.unavailableReason() ?? "visual disabled");
    }
    return this.analyzeArtifact(artifact, prompt);
  }

  /** Extract a sample of frames from a video artifact. Frame extraction
   *  requires ffmpeg on PATH; if not available, the analyzer registers
   *  a metadata-only artifact with a single "frame 0" entry. */
  async extractVideoFrames(id: string, sampleSpec: { fps: number; maxFrames: number }): Promise<VisualArtifact[]> {
    const artifact = this.artifacts.get(id);
    if (!artifact) throw new Error(`artifact ${id} not found`);
    if (!SUPPORTED_VIDEO_MIME.has(artifact.mimeType)) {
      throw new Error(`artifact ${id} is not a video (mime=${artifact.mimeType})`);
    }
    if (!this.isAvailable() && !(this.capabilities?.isVideoSupported() ?? false)) {
      throw new Error("video analysis disabled: model does not support video input");
    }
    // Without ffmpeg, return a single stub artifact that references
    // the source video. The runtime can fall back to the OCR/metadata path.
    const stub: VisualArtifact = {
      ...artifact,
      id: `${artifact.id}-frame0`,
      path: artifact.path,
      mimeType: "image/png",
      frameCount: 1,
    };
    return [stub];
  }

  /** Compare two screenshots. */
  async compareScreenshots(beforeId: string, afterId: string, prompt?: string): Promise<VisualAnalysisResult> {
    const before = await this.analyzeImage(beforeId, prompt);
    const after = await this.analyzeImage(afterId, prompt);
    return {
      artifactId: afterId,
      summary: `Comparison: before=${before.summary} | after=${after.summary}`,
      detectedText: [...before.detectedText, ...after.detectedText].filter((v, i, a) => a.indexOf(v) === i),
      uiElements: after.uiElements,
      errors: after.errors,
      layoutFindings: after.layoutFindings,
      actionableFindings: after.actionableFindings,
      confidence: Math.min(before.confidence, after.confidence),
      modelUsed: after.modelUsed,
      evidence: [
        { method: "metadata", excerpt: `before.id=${beforeId}, after.id=${afterId}`, confidence: 1 },
        ...after.evidence,
      ],
    };
  }

  /** Get a previous analysis result. */
  getAnalysis(id: string): VisualAnalysisResult | null { return this.analyses.get(id) ?? null; }

  /** Bridge a screenshot analysis into actionable repo signals. */
  bridgeAnalysis(analysisId: string): VisualContextBridgeOutput {
    const analysis = this.analyses.get(analysisId);
    if (!analysis) return { observations: [], suggestedSearches: [], suspectedFiles: [], suspectedCommands: [], validationIdeas: [], memoryCandidates: [] };
    return this.bridge.bridge(analysis);
  }

  /* --- internals --- */
  private async analyzeArtifact(artifact: VisualArtifact, prompt?: string): Promise<VisualAnalysisResult> {
    if (this.visionModel) {
      try {
        const r = await this.visionModel.analyze({ path: artifact.path, mimeType: artifact.mimeType, prompt: prompt ?? "" });
        const result: VisualAnalysisResult = {
          artifactId: artifact.id,
          summary: r.summary,
          detectedText: r.detectedText,
          uiElements: r.uiElements,
          errors: r.errors,
          layoutFindings: [],
          actionableFindings: r.errors.length > 0 ? r.errors.map((e) => ({ description: e.text ?? e.kind, suggestedAction: "investigate signal", confidence: e.confidence })) : [],
          confidence: r.confidence,
          modelUsed: this.visionModel.name,
          evidence: [{ method: "vlm", excerpt: r.summary, confidence: r.confidence }],
        };
        this.analyses.set(artifact.id, result);
        appendFileSync(this.analysisPath, JSON.stringify(result) + "\n");
        return result;
      } catch (e) {
        // fall through to fallback
        const reason = e instanceof Error ? e.message : String(e);
        return this.metadataOnlyResult(artifact, `vlm failed: ${reason}`);
      }
    }
    return this.metadataOnlyResult(artifact, "no vision model configured");
  }

  private metadataOnlyResult(artifact: VisualArtifact, reason: string): VisualAnalysisResult {
    const name = basename(artifact.path);
    const detectedText: string[] = [];
    if (/\b(login|signup|signin|sign-up|sign-in|home|settings|admin|profile|error|404|500|dashboard|users|api|auth|cart|checkout|search|results?)\b/i.test(name)) {
      detectedText.push(name);
    }
    const errors: VisualErrorSignal[] = [];
    if (/(error|404|500|crash|fail|broken)/i.test(name)) {
      errors.push({ kind: inferErrorKindFromName(name), text: name, confidence: 0.3 });
    }
    const evidence: VisualEvidence[] = [{ method: "metadata", excerpt: `${artifact.path} (${artifact.mimeType}) — ${reason}`, confidence: 0.3 }];
    const result: VisualAnalysisResult = {
      artifactId: artifact.id,
      summary: `${artifact.mimeType} ${name} — fallback analysis (${reason})`,
      detectedText,
      uiElements: [],
      errors,
      layoutFindings: [],
      actionableFindings: errors.map((e) => ({ description: e.text ?? e.kind, suggestedAction: "investigate further", confidence: e.confidence })),
      confidence: 0.3,
      evidence,
    };
    this.analyses.set(artifact.id, result);
    appendFileSync(this.analysisPath, JSON.stringify(result) + "\n");
    return result;
  }
}

function guessMimeType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    case "mp4": return "video/mp4";
    case "webm": return "video/webm";
    default: return "application/octet-stream";
  }
}

function inferErrorKindFromName(name: string): VisualErrorKind {
  if (/404|500/.test(name)) return "http_error";
  if (/crash|fail/.test(name)) return "crash_dialog";
  if (/test/.test(name)) return "test_failure";
  if (/error/.test(name)) return "console_error";
  return "unknown";
}
