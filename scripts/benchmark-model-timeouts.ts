import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { createLiveReaperGateway } from "../tests/fixtures/live-gateway.js";
import { generateStructuredJson } from "../src/model/json-response.js";

interface SampleResult {
  label: string;
  kind: "generate" | "structured";
  ok: boolean;
  durationMs: number;
  error?: string;
  contentPreview?: string;
}

const provider = process.env.REAPER_LIVE_PROVIDER ?? process.env.REAPER_MODEL_PROVIDER ?? "deepseek";
const model = process.env.DEEPSEEK_MODEL || undefined;
const timeoutMs = Number(process.env.REAPER_BENCH_TIMEOUT_MS ?? process.env.REAPER_LIVE_MODEL_TIMEOUT_MS ?? 180000);
const repeats = Number(process.env.REAPER_BENCH_REPEATS ?? 2);

process.env.REAPER_LIVE_MODEL_TIMEOUT_MS = String(timeoutMs);
process.env.REAPER_MODEL_CALL_TIMEOUT_MS = String(timeoutMs);
process.env.REAPER_LIVE_MODEL_MAX_RETRIES = process.env.REAPER_LIVE_MODEL_MAX_RETRIES ?? "0";
process.env.REAPER_LIVE_LOG_STDOUT = process.env.REAPER_LIVE_LOG_STDOUT ?? "1";

const cases = [
  {
    label: "tiny-ok",
    maxTokens: 64,
    prompt: "Reply with exactly this JSON: {\"ok\":true}",
  },
  {
    label: "planner-small-json",
    maxTokens: 1024,
    prompt: [
      "Return ONLY JSON.",
      "Create a concise coding-agent plan for building a tiny todo API.",
      "Schema: {\"steps\":[{\"id\":\"string\",\"title\":\"string\",\"instructions\":\"string\",\"tool_calls\":[]}],\"testGuidance\":\"string\"}",
    ].join("\n"),
  },
  {
    label: "planner-reaper-sized-json",
    maxTokens: 4096,
    prompt: makePlannerSizedPrompt(),
  },
];

async function main() {
  const { gateway, config } = createLiveReaperGateway("benchmark-model-timeouts", provider, model);
  config.models.default_model.maxRetries = 0;
  config.models.default_model.timeoutMs = timeoutMs;
  config.models.fast_reasoner = { ...config.models.default_model, maxRetries: 0, timeoutMs };
  config.models.skim_model = { ...config.models.default_model, maxRetries: 0, timeoutMs };
  config.models.cheap_router = { ...config.models.default_model, maxRetries: 0, timeoutMs };

  const profile = await gateway.resolveRole("main_reasoner");
  const results: SampleResult[] = [];
  console.log(JSON.stringify({ event: "benchmark_start", provider: profile.provider, model: profile.model, timeoutMs, repeats }));

  for (const testCase of cases) {
    for (let index = 0; index < repeats; index += 1) {
      results.push(await measure(`${testCase.label}#${index + 1}`, "generate", async () => {
        const result = await gateway.generate({
          role: "main_reasoner",
          messages: [{ role: "user", content: testCase.prompt }],
          maxTokens: testCase.maxTokens,
        });
        return result.content;
      }));

      results.push(await measure(`${testCase.label}#${index + 1}`, "structured", async () => {
        const result = await generateStructuredJson({
          modelGateway: gateway,
          role: "main_reasoner",
          maxTokens: testCase.maxTokens,
          messages: [{ role: "user", content: testCase.prompt }],
          parse(value) {
            if (!value || typeof value !== "object") throw new Error("Expected object");
            return value;
          },
        });
        return JSON.stringify(result);
      }));
    }
  }

  const okDurations = results.filter((item) => item.ok).map((item) => item.durationMs).sort((a, b) => a - b);
  const summary = {
    provider: profile.provider,
    model: profile.model,
    timeoutMs,
    repeats,
    total: results.length,
    ok: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    minMs: percentile(okDurations, 0),
    p50Ms: percentile(okDurations, 0.5),
    p90Ms: percentile(okDurations, 0.9),
    p95Ms: percentile(okDurations, 0.95),
    maxMs: percentile(okDurations, 1),
    recommendedTimeoutMs: recommendTimeout(okDurations),
    results,
  };

  const outDir = path.join("/workspace", ".reaper", "provider-benchmarks");
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `model-timeouts-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(outPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(JSON.stringify({ event: "benchmark_summary", ...summary, results: undefined, outPath }, null, 2));
}

async function measure(label: string, kind: SampleResult["kind"], fn: () => Promise<string>): Promise<SampleResult> {
  const start = performance.now();
  try {
    const content = await withTimeout(fn(), timeoutMs + 5000, `${kind}:${label}`);
    const durationMs = Math.round(performance.now() - start);
    const result = { label, kind, ok: true, durationMs, contentPreview: content.slice(0, 160) };
    console.log(JSON.stringify({ event: "sample", ...result }));
    return result;
  } catch (error) {
    const durationMs = Math.round(performance.now() - start);
    const result = { label, kind, ok: false, durationMs, error: error instanceof Error ? error.message : String(error) };
    console.log(JSON.stringify({ event: "sample", ...result }));
    return result;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Benchmark wrapper timed out after ${ms}ms (${label})`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * p) - 1));
  return values[index] ?? null;
}

function recommendTimeout(values: number[]): number | null {
  if (values.length === 0) return null;
  const p95 = percentile(values, 0.95) ?? 0;
  const max = percentile(values, 1) ?? 0;
  return Math.ceil(Math.max(120000, p95 * 3, max * 2) / 30000) * 30000;
}

function makePlannerSizedPrompt(): string {
  const fakeTree = Array.from({ length: 80 }, (_, i) => `src/module-${i}/file-${i}.ts`).join("\n");
  return [
    "# Planner Subagent Tool",
    "Return ONLY JSON with installs, steps, and testGuidance.",
    "Task: Build a full-stack task management app with auth, tasks, filters, database, tests, Docker, docs.",
    "Compact file tree:",
    fakeTree,
    "Lean planner context: empty workspace.",
    "Create small executable steps. tool_calls must be [].",
  ].join("\n\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
