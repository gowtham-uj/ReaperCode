import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

// ── JSON-RPC types ──
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown;
}
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

// ── Transport ──
interface McpTransport {
  send(msg: unknown): void;
  onMessage(handler: (msg: JsonRpcResponse) => void): void;
  close(): void;
}

function createStdioTransport(command: string, args: string[], env?: Record<string, string>): McpTransport {
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  const handlers: Array<(msg: JsonRpcResponse) => void> = [];
  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg && typeof msg === "object" && "id" in msg) {
        for (const handler of handlers) handler(msg as JsonRpcResponse);
      }
    } catch { /* skip non-JSON */ }
  });
  child.stderr?.on("data", (d) => {
    console.warn(`[mcp:stdio:stderr] ${String(d).slice(0, 200)}`);
  });
  return {
    send: (msg) => child.stdin!.write(JSON.stringify(msg) + "\n"),
    onMessage: (handler) => { handlers.push(handler); },
    close: () => { child.kill(); rl.close(); },
  };
}

function createHttpTransport(serverUrl: string): McpTransport {
  const handlers: Array<(msg: JsonRpcResponse) => void> = [];
  let running = true;

  (async () => {
    while (running) {
      try {
        const res = await fetch(`${serverUrl}/sse`, {
          headers: { Accept: "text/event-stream" },
          signal: AbortSignal.timeout(0), // persistent
        });
        const reader = res.body?.getReader();
        if (!reader) break;
        const decoder = new TextDecoder();
        let buf = "";
        while (running) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const msg = JSON.parse(line.slice(6));
                if (msg && "id" in msg) {
                  for (const h of handlers) h(msg as JsonRpcResponse);
                }
              } catch {}
            }
          }
        }
      } catch {
        await new Promise((r) => setTimeout(r, 2000)); // reconnect
      }
    }
  })();

  return {
    send: async (msg) => {
      await fetch(`${serverUrl}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg),
      }).catch(() => {});
    },
    onMessage: (handler) => { handlers.push(handler); },
    close: () => { running = false; },
  };
}

// ── MCP Tool Stub ──
export interface McpToolStub {
  name: string;
  description: string;
  inputSchema: unknown;
  serverName: string;
}

// ── MCP Client ──
export class McpClient {
  private transport!: McpTransport;
  private tools: McpToolStub[] = [];
  private pendingRequests = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private requestId = 0;
  private connected = false;

  constructor(private readonly serverName: string) {}

  async connect(config: { type: "stdio" | "http"; command?: string; args?: string[]; url?: string; env?: Record<string, string> }): Promise<void> {
    this.transport = config.type === "stdio"
      ? createStdioTransport(config.command!, config.args ?? [], config.env)
      : createHttpTransport(config.url!);

    this.transport.onMessage((msg) => {
      if ("id" in msg && typeof msg.id === "number") {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          this.pendingRequests.delete(msg.id);
          if (msg.error) pending.reject(new Error(msg.error.message));
          else pending.resolve(msg.result);
        }
      }
    });

    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "reaper", version: "0.1.0" },
    });

    const result = (await this.request("tools/list", {})) as { tools?: Array<{ name: string; description: string; inputSchema: unknown }> };
    this.tools = (result.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      serverName: this.serverName,
    }));
    this.connected = true;
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.requestId;
    const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP request '${method}' timed out after 30s`));
      }, 30_000);
      this.pendingRequests.set(id, {
        resolve: (v) => { clearTimeout(timeout); resolve(v); },
        reject: (e) => { clearTimeout(timeout); reject(e); },
      });
      this.transport.send(msg);
    });
  }

  getTools(): McpToolStub[] { return this.tools; }
  isConnected(): boolean { return this.connected; }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.request("tools/call", { name, arguments: args });
    return result;
  }

  async refreshTools(): Promise<number> {
    const before = this.tools.length;
    const result = (await this.request("tools/list", {})) as { tools?: Array<{ name: string; description: string; inputSchema: unknown }> };
    this.tools = (result.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      serverName: this.serverName,
    }));
    return this.tools.length - before;
  }

  close() { this.transport.close(); this.connected = false; }
}
