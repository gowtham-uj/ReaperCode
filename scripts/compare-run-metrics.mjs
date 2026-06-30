#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

function usage() {
  console.error('Usage: node scripts/compare-run-metrics.mjs <run-or-workspace> [<run-or-workspace> ...]');
  process.exit(2);
}

const inputs = process.argv.slice(2);
if (inputs.length === 0) usage();

function findRunDir(input) {
  const abs = path.resolve(input);
  if (existsSync(path.join(abs, 'model-calls'))) return abs;
  const runsRoot = path.join(abs, '.reaper', 'runs');
  if (existsSync(runsRoot)) {
    const runs = readdirSync(runsRoot)
      .map((name) => path.join(runsRoot, name))
      .filter((p) => existsSync(path.join(p, 'model-calls')))
      .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
    if (runs.length) return runs.at(-1);
  }
  throw new Error(`No Reaper-style run dir with model-calls found under ${input}`);
}

function safeJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; }
}

function listFilesRecursive(root, ignore = new Set(['.git', '.reaper', 'node_modules', 'dist', '.next', '.pnpm-store', 'coverage'])) {
  const out = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (ignore.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(path.relative(root, full));
    }
  }
  walk(root);
  return out.sort();
}

function parseToolArgs(raw) {
  if (!raw || typeof raw !== 'string') return {};
  try { return JSON.parse(raw); } catch {}
  const trimmed = raw.trim();
  try { return JSON.parse(trimmed); } catch {}
  return { _raw: raw };
}

function summarize(input) {
  const runDir = findRunDir(input);
  const workspace = path.resolve(runDir, '..', '..', '..');
  const modelDir = path.join(runDir, 'model-calls');
  const modelFiles = readdirSync(modelDir).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(modelDir, f));
  const emittedTools = [];
  const messageCounts = [];
  const finishReasons = [];

  for (const file of modelFiles) {
    const doc = safeJson(file);
    if (!doc) continue;
    const messages = doc.request?.messages ?? [];
    messageCounts.push(messages.length);
    for (const event of doc.streamEvents ?? []) {
      if (event?.type === 'message_end') finishReasons.push(event.data?.finishReason ?? event.finishReason ?? 'unknown');
      if (event?.type !== 'tool_call') continue;
      const data = event.data ?? {};
      const args = parseToolArgs(data.arguments ?? event.content ?? '');
      emittedTools.push({
        callFile: path.basename(file),
        id: data.id,
        name: data.name,
        args,
      });
    }
  }

  const toolCounts = Object.create(null);
  const bashCommands = [];
  const replaceFailures = [];
  const trajectoryPath = path.join(runDir, 'logs', 'reaper-trajectory.jsonl');
  const trajectoryUnique = new Map();
  if (existsSync(trajectoryPath)) {
    for (const line of readFileSync(trajectoryPath, 'utf8').split(/\n/)) {
      if (!line.trim()) continue;
      const d = safeParse(line);
      if (!d || d.kind !== 'tool_call') continue;
      const key = `${d.decision_id ?? ''}:${d.tool_name ?? ''}:${d.status ?? ''}`;
      trajectoryUnique.set(key, d);
      if (d.tool_name === 'replace_in_file' && d.status === 'failed') replaceFailures.push(d);
    }
  }

  for (const t of emittedTools) {
    toolCounts[t.name] = (toolCounts[t.name] ?? 0) + 1;
    if (t.name === 'bash') bashCommands.push(String(t.args?.cmd ?? t.args?.command ?? t.args?._raw ?? ''));
  }

  const repeatedBash = topCounts(bashCommands, 10).filter(([, count]) => count > 1);
  const foregroundServerBash = bashCommands.filter((cmd) => /&\s*(?:\n|$)|\bpnpm\s+--filter\s+\S+\s+start\b|\bnpm\s+run\s+dev\b|\bnode\s+dist\/index\.js\b/.test(cmd));
  const broadVerify = bashCommands.filter((cmd) => /\b(?:pnpm|npm|yarn|bun)\b[\s\S]*(?:\btest\b|\bbuild\b)/.test(cmd));
  const exactReplaceTools = emittedTools.filter((t) => t.name === 'replace_in_file' && t.args?.oldString);

  let fileCount = 0;
  let appFiles = 0;
  let packageFiles = 0;
  if (existsSync(workspace)) {
    const files = listFilesRecursive(workspace);
    fileCount = files.length;
    appFiles = files.filter((f) => f.startsWith('apps/')).length;
    packageFiles = files.filter((f) => f.startsWith('packages/')).length;
  }

  return {
    input,
    workspace,
    runDir,
    modelCalls: modelFiles.length,
    finalMessageCount: messageCounts.at(-1) ?? 0,
    maxMessageCount: Math.max(0, ...messageCounts),
    finishReasons: countMap(finishReasons),
    emittedToolCalls: emittedTools.length,
    toolCounts,
    fileCount,
    appFiles,
    packageFiles,
    broadVerifyCount: broadVerify.length,
    foregroundServerBashCount: foregroundServerBash.length,
    repeatedBash,
    exactReplaceCount: exactReplaceTools.length,
    replaceFailureCount: replaceFailures.length,
    trajectoryUniqueToolEvents: trajectoryUnique.size,
  };
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}
function countMap(items) {
  const out = Object.create(null);
  for (const item of items) out[item] = (out[item] ?? 0) + 1;
  return out;
}
function topCounts(items, n) {
  return Object.entries(countMap(items)).sort((a, b) => b[1] - a[1]).slice(0, n);
}

const summaries = inputs.map(summarize);
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), runs: summaries }, null, 2));

if (summaries.length >= 2) {
  const [a, b] = summaries;
  const delta = {
    modelCalls: b.modelCalls - a.modelCalls,
    emittedToolCalls: b.emittedToolCalls - a.emittedToolCalls,
    files: b.fileCount - a.fileCount,
    broadVerify: b.broadVerifyCount - a.broadVerifyCount,
    replaceFailures: b.replaceFailureCount - a.replaceFailureCount,
    foregroundServerBash: b.foregroundServerBashCount - a.foregroundServerBashCount,
  };
  console.error('\nDelta second-minus-first:');
  console.error(JSON.stringify(delta, null, 2));
}
