import v8 from "node:v8";

export interface MemoryPressure {
  heapUsedMB: number;
  heapLimitMB: number;
  usageRatio: number;
  level: "normal" | "elevated" | "critical";
}

export function getMemoryPressure(): MemoryPressure {
  const stats = v8.getHeapStatistics();
  const heapUsedMB = Math.round(stats.used_heap_size / (1024 * 1024));
  const heapLimitMB = Math.round(stats.heap_size_limit / (1024 * 1024));
  const usageRatio = stats.used_heap_size / stats.heap_size_limit;

  let level: MemoryPressure["level"] = "normal";
  if (usageRatio > 0.85) level = "critical";
  else if (usageRatio > 0.70) level = "elevated";

  return { heapUsedMB, heapLimitMB, usageRatio, level };
}

/**
 * Call before each LLM request. If memory is elevated, evict caches.
 * If critical, throw to prevent OOM crash.
 */
export function guardMemory(): void {
  const pressure = getMemoryPressure();

  if (pressure.level === "critical") {
    // Force garbage collection if available
    if (typeof global.gc === "function") {
      global.gc();
      const after = getMemoryPressure();
      if (after.level === "critical") {
        throw new Error(
          `Memory pressure critical: ${after.heapUsedMB}MB / ${after.heapLimitMB}MB. ` +
          `Cannot proceed with LLM call. Try a smaller model or reduce context.`
        );
      }
    } else {
      throw new Error(
        `Memory pressure critical: ${pressure.heapUsedMB}MB / ${pressure.heapLimitMB}MB. ` +
        `Start node with --expose-gc flag or reduce context size.`
      );
    }
  }

  if (pressure.level === "elevated") {
    console.warn(`[memory-guard] Elevated memory: ${pressure.heapUsedMB}MB / ${pressure.heapLimitMB}MB (${(pressure.usageRatio * 100).toFixed(0)}%)`);
  }
}
