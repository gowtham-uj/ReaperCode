import { useCallback, useMemo, useState } from "react";

/** Kept per process. Roughly a screenful of scrollback at typical line lengths. */
const MAX_LINES_PER_PROCESS = 2_000;

export interface BackgroundProcess {
  pid: number;
  cmd: string;
  lines: string[];
  exited: boolean;
}

export interface DetectedServer {
  pid: number;
  url: string;
  port: number;
}

export interface BackgroundState {
  processes: BackgroundProcess[];
  servers: DetectedServer[];
  /** Return true when the notification belongs to the background channel. */
  ingest(method: string, params: Record<string, unknown>): boolean;
  clear(): void;
}

/**
 * Session-level background output. Processes outlive the turn that launched
 * them, so this intentionally stays outside the transcript reducer.
 */
export function useBackgroundState(): BackgroundState {
  const [processes, setProcesses] = useState<BackgroundProcess[]>([]);
  const [servers, setServers] = useState<DetectedServer[]>([]);

  const appendOutput = useCallback((pid: number, cmd: string, delta: string, system: boolean): void => {
    setProcesses((current) => {
      const index = current.findIndex((entry) => entry.pid === pid);
      const existing = current[index];
      const incoming = delta.split(/\r?\n/);
      const previous = existing?.lines ?? [];
      const head = previous.slice(0, -1);
      const joined = `${previous[previous.length - 1] ?? ""}${incoming[0] ?? ""}`;
      const lines = [...head, joined, ...incoming.slice(1)].slice(-MAX_LINES_PER_PROCESS);
      const next: BackgroundProcess = {
        pid,
        cmd: existing?.cmd ?? cmd,
        lines,
        exited: existing?.exited || (system && delta.includes("Process exited")),
      };
      if (index === -1) return [...current, next];
      return current.map((entry, at) => (at === index ? next : entry));
    });
  }, []);

  const ingest = useCallback((method: string, params: Record<string, unknown>): boolean => {
    if (method === "background/outputDelta") {
      const pid = Number(params.pid);
      if (!Number.isInteger(pid)) return true;
      const delta = String(params.delta ?? "");
      const system = params.stream === "system";
      appendOutput(pid, String(params.cmd ?? ""), delta, system);
      if (system && delta.includes("Process exited")) {
        setServers((current) => current.filter((server) => server.pid !== pid));
      }
      return true;
    }

    if (method === "background/serverDetected") {
      const url = String(params.url ?? "");
      const port = Number(params.port);
      const pid = Number(params.pid);
      if (!url || !Number.isInteger(port)) return true;
      setServers((current) =>
        current.some((server) => server.url === url) ? current : [...current, { pid, url, port }],
      );
      return true;
    }
    return false;
  }, [appendOutput]);

  const clear = useCallback((): void => {
    setProcesses([]);
    setServers([]);
  }, []);

  return useMemo(() => ({ processes, servers, ingest, clear }), [processes, servers, ingest, clear]);
}
