/**
 * ScreenshotContextBridge — convert a VisualAnalysisResult into
 * actionable repo signals: suggested searches, suspected files,
 * validation ideas, and memory candidates.
 *
 * Rules (from the spec):
 *  - Visual findings are *evidence*, not truth.
 *  - Do not overwrite file/test evidence with screenshot guesses.
 *  - Use screenshots to guide search/debugging.
 *  - Always connect visual claims to repo validation when possible.
 */

import type { VisualAnalysisResult, VisualContextBridgeOutput } from "./types.js";

const HTTP_ERROR_RX = /\b(?:404|500|502|503|400|401|403|405|409)\b/;
const ROUTE_HINT_RX = /(?:\/|@|href=|src=)\/?(api\/[A-Za-z0-9_/-]+|[A-Za-z0-9_/-]*\/[A-Za-z0-9_/-]+)/g;
const MODULE_NOT_FOUND_RX = /Module not found:\s*['"]?([^'"\s]+)['"]?/;
const STACK_FRAME_RX = /at\s+(?:[A-Za-z0-9_.]+\s+)?\(?([A-Za-z0-9_./-]+\.[A-Za-z0-9]+):(\d+):(\d+)\)?/;

export class ScreenshotContextBridge {
  bridge(analysis: VisualAnalysisResult): VisualContextBridgeOutput {
    const observations: VisualContextBridgeOutput["observations"] = [];
    const suggestedSearches = new Set<string>();
    const suspectedFiles = new Set<string>();
    const suspectedCommands = new Set<string>();
    const validationIdeas = new Set<string>();

    for (const t of analysis.detectedText) {
      observations.push({ kind: inferObservationKind(t), text: t });
      // Route patterns like "/api/users"
      for (const m of t.matchAll(ROUTE_HINT_RX)) {
        const r = m[1]!;
        if (r.length > 2) suggestedSearches.add(r);
      }
      // Module not found
      const m = MODULE_NOT_FOUND_RX.exec(t);
      if (m) {
        suggestedSearches.add(m[1]!);
        suspectedFiles.add("tsconfig.json");
        suspectedFiles.add("package.json");
        validationIdeas.add("run typescript compiler");
      }
      // Stack frames
      const stackM = STACK_FRAME_RX.exec(t);
      if (stackM) {
        suspectedFiles.add(stackM[1]!);
        validationIdeas.add(`open file ${stackM[1]} at line ${stackM[2]}`);
      }
      // HTTP errors
      if (HTTP_ERROR_RX.test(t)) {
        suspectedFiles.add("src/routes");
        suggestedSearches.add(t);
        validationIdeas.add("curl the failing endpoint");
        suspectedCommands.add("curl -i");
      }
    }

    for (const e of analysis.errors) {
      if (e.text) {
        observations.push({ kind: "error", text: e.text });
        if (HTTP_ERROR_RX.test(e.text)) {
          suggestedSearches.add(e.text);
          validationIdeas.add("curl the failing endpoint");
        }
      }
    }

    for (const lf of analysis.layoutFindings) {
      observations.push({ kind: "layout", text: lf.description });
      suspectedFiles.add("src/components");
      validationIdeas.add("capture an after-screenshot and compare");
    }

    const memoryCandidates = analysis.actionableFindings.map((f) => ({
      id: `mem-${randomHex(8)}`,
      scope: "transient" as const,
      kind: "pitfall" as const,
      content: f.description,
      evidence: [],
      confidence: f.confidence,
      source: "screenshot_analysis" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tags: ["visual", "transient"],
      sensitive: false,
      editable: true,
    }));

    return {
      observations,
      suggestedSearches: [...suggestedSearches],
      suspectedFiles: [...suspectedFiles],
      suspectedCommands: [...suspectedCommands],
      validationIdeas: [...validationIdeas],
      memoryCandidates,
    };
  }
}

function inferObservationKind(text: string): VisualContextBridgeOutput["observations"][number]["kind"] {
  if (HTTP_ERROR_RX.test(text)) return "error";
  if (/traceback|exception|stack/i.test(text)) return "trace";
  if (/button|input|modal|menu|table|card|navbar|sidebar|dropdown|toast/i.test(text)) return "ui_state";
  return "ui_state";
}

function randomHex(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}
