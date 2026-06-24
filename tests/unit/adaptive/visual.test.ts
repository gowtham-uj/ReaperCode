import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VisualInputAnalyzer } from "../../../src/adaptive/visual-input-analyzer.js";
import { ScreenshotContextBridge } from "../../../src/adaptive/screenshot-context-bridge.js";
import { ModelCapabilitiesRegistry } from "../../../src/adaptive/model-capabilities.js";
import type { VisualAnalysisResult } from "../../../src/adaptive/types.js";

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), "visual-"));
}

test("VisualInputAnalyzer metadata fallback works without a model", async () => {
  const dir = makeTempRoot();
  try {
    const img = join(dir, "404.png");
    writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const a = new VisualInputAnalyzer({ workspaceRoot: dir });
    const artifact = a.registerArtifact({ path: img, source: "user_upload" });
    assert.ok(artifact);
    const r = await a.analyzeImage(artifact.id);
    assert.match(r.summary, /image\/png/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VisualInputAnalyzer with no capabilities and no vision model is unavailable", () => {
  const dir = makeTempRoot();
  try {
    const a = new VisualInputAnalyzer({ workspaceRoot: dir });
    assert.equal(a.isAvailable(), false);
    assert.match(a.unavailableReason() ?? "", /no vision model|not support/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("VisualInputAnalyzer is available when capabilities say so, even without vision model", () => {
  const dir = makeTempRoot();
  try {
    const caps = new ModelCapabilitiesRegistry({ capabilities: { imageInput: true, videoInput: false, toolUse: true, streaming: true, parallelToolUse: true, detectedAt: "2026-01-01T00:00:00Z", source: "explicit" } });
    const a = new VisualInputAnalyzer({ workspaceRoot: dir, capabilities: caps });
    assert.equal(a.isAvailable(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tryAnalyzeScreenshot returns available=false when model does not support images", async () => {
  const dir = makeTempRoot();
  try {
    const img = join(dir, "x.png");
    writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const caps = new ModelCapabilitiesRegistry({ capabilities: { imageInput: false, videoInput: false, toolUse: true, streaming: true, parallelToolUse: true, detectedAt: "2026-01-01T00:00:00Z", source: "explicit" } });
    const a = new VisualInputAnalyzer({ workspaceRoot: dir, capabilities: caps });
    const id = a.registerArtifact({ path: img, source: "user_upload" })!.id;
    const outcome = await a.tryAnalyzeScreenshot(id);
    assert.equal(outcome.available, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ScreenshotContextBridge extracts observations from detected text", () => {
  const bridge = new ScreenshotContextBridge();
  const analysis: VisualAnalysisResult = {
    artifactId: "x",
    summary: "error",
    detectedText: ["/api/users 500", "Module not found: 'foo'"],
    uiElements: [],
    errors: [{ kind: "http_error", text: "500", confidence: 0.8 }],
    layoutFindings: [],
    actionableFindings: [{ description: "Module not found: 'foo'", suggestedAction: "add dependency", confidence: 0.8 }],
    confidence: 0.8,
    evidence: [],
  };
  const out = bridge.bridge(analysis);
  assert.equal(out.observations.length, 3);
  assert.ok(out.suspectedFiles.includes("package.json"));
  assert.ok(out.validationIdeas.length > 0);
  assert.ok(out.memoryCandidates.length > 0);
});
