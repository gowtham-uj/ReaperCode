import type {SubagentWorkerMessage} from "../../../src/runtime/subagent-pool.js";

const jobId = process.argv[3] ?? "unknown";
process.on("message", (msg: unknown) => {
  void msg;
  const message: SubagentWorkerMessage = {type: "error", jobId, error: "forced worker error"};
  if (process.send) process.send(message);
  process.disconnect?.();
});
