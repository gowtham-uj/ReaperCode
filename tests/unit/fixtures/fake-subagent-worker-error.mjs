const jobId = process.argv[3] ?? "unknown";
process.on("message", () => {
  if (process.send) {
    process.send({type: "error", jobId, error: "forced worker error"});
  }
  process.disconnect?.();
});
