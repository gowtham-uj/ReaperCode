const jobId = process.argv[3] ?? "unknown";
process.on("message", () => {
  if (process.send) {
    process.send({type: "complete", jobId, result: {ok: true}});
  }
  process.disconnect?.();
});
