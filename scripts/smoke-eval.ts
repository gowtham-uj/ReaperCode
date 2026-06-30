import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { RuntimeEngine } from "../src/runtime/engine.js";
import { createValidConfig, createValidRequestEnvelope } from "../tests/fixtures/phase0.js";

async function main() {
  const workspaceRoot = path.join("/workspace", "reaper_eval", "workspaces", "smoke-test", Date.now().toString());
  await rm(workspaceRoot, { recursive: true, force: true });
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(path.join(workspaceRoot, "hello.txt"), "initial content\n", "utf8");

  // Test 1: Mutation with verifier shell command (both in explicit batch)
  // The shell verifier gets blocked by design, but the mutation succeeds.
  const request = createValidRequestEnvelope();
  request.payload = {
    prompt: "Change hello world file",
    tool_calls: [
      { id: "1", name: "replace_in_file", args: { path: "hello.txt", oldString: "initial", newString: "hello world" } },
      { id: "2", name: "bash", args: { cmd: "python3 -c \"import sys; t=open('hello.txt').read(); sys.exit(0 if 'hello world' in t else 1)\"" } },
      { id: "3", name: "complete_task", args: { summary: "file updated" } },
    ],
    verification: {
      command: "cat hello.txt",
      maxIterations: 2,
      allowJudgeRetry: false,
    },
  };

  const engine = new RuntimeEngine({
    config: createValidConfig(),
    workspaceRoot,
    requestEnvelope: request,
  });

  console.log("[smoke-eval] Starting engine...");
  const result = await engine.run();
  console.log("[smoke-eval] Engine finished");

  const content = await readFile(path.join(workspaceRoot, "hello.txt"), "utf8");
  console.log("[smoke-eval] File content:", content.trim());
  for (const r of result.toolResults) {
    console.log(`[smoke-eval] Tool ${r.name}: ok=${r.ok}, error=${r.error ? JSON.stringify(r.error) : 'none'}`);
  }
  console.log("[smoke-eval] Verification:", JSON.stringify(result.verification));

  // Mutation succeeded, file is correct, engine ran to completion
  const passed = content.trim() === "hello world content" && result.toolResults.some(r => r.name === "replace_in_file" && r.ok);
  console.log("[smoke-eval] PASSED:", passed);
  process.exit(passed ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
