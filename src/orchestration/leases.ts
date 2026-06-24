import type { SubTaskContract } from "./scheduler.js";

export interface FileLeaseMap {
  [subTaskId: string]: Set<string>;
}

export function allocateFileLeases(plan: SubTaskContract[]): FileLeaseMap {
  const owners = new Map<string, string>();
  const leases: FileLeaseMap = {};

  for (const task of plan) {
    leases[task.id] = new Set();
    for (const file of task.files) {
      const existing = owners.get(file);
      if (existing && existing !== task.id) {
        throw new Error(`ELEASE_VIOLATION: file '${file}' is assigned to both '${existing}' and '${task.id}'`);
      }
      owners.set(file, task.id);
      const lease = leases[task.id];
      if (lease) {
        lease.add(file);
      }
    }
  }

  return leases;
}

export function assertLeaseAllowsFile(subTaskId: string, filePath: string, leases: FileLeaseMap): void {
  const allowed = leases[subTaskId];
  if (!allowed || !allowed.has(filePath)) {
    throw new Error(`ELEASE_VIOLATION: subtask '${subTaskId}' cannot write '${filePath}'`);
  }
}
