import { toolRegistry } from "../registry.js";
import { McpClient, type McpToolStub } from "./client.js";
import type { McpServerConfig } from "./config.js";

export interface ActiveToolEntry {
  name: string;
  description: string;
  argsSchema: unknown;
  source: "built-in" | string; // "built-in" or "mcp:<serverName>"
  lastUsedTurn: number;
  pinnedUntilTurn: number;
  searchScore: number;
}

export class MergedToolRegistry {
  private readonly builtIn = new Map<string, ActiveToolEntry>();
  private readonly mcpStubs = new Map<string, McpToolStub>();
  private readonly activeSet = new Map<string, ActiveToolEntry>();
  private readonly mcpClients = new Map<string, McpClient>();
  private currentTurn = 0;

  private readonly MAX_ACTIVE_TOOLS = 12;
  private readonly MIN_BUILTIN_SLOTS = 5;
  private readonly MCP_TOOL_STALE_AFTER = 8;
  private readonly MCP_PROMOTION_LOCK = 3;

  constructor() {
    for (const [name, entry] of Object.entries(toolRegistry)) {
      const activeEntry: ActiveToolEntry = {
        name,
        description: entry.description,
        argsSchema: entry.argsSchema,
        source: "built-in",
        lastUsedTurn: 0,
        pinnedUntilTurn: 0,
        searchScore: 0,
      };
      this.builtIn.set(name, activeEntry);
      this.activeSet.set(name, activeEntry);
    }
  }

  async addMcpServer(config: McpServerConfig): Promise<number> {
    const client = new McpClient(config.name);
    try {
      const { name: _name, autoDiscover: _ad, ...connectConfig } = config as McpServerConfig & { autoDiscover?: boolean };
      await client.connect(connectConfig as { type: "stdio" | "http"; command?: string; args?: string[]; url?: string; env?: Record<string, string> });
    } catch (err) {
      console.warn(`[mcp] Failed to connect to server '${config.name}': ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
    this.mcpClients.set(config.name, client);
    let added = 0;
    for (const stub of client.getTools()) {
      const key = `mcp:${config.name}:${stub.name}`;
      if (this.mcpStubs.has(key)) continue;
      this.mcpStubs.set(key, stub);
      added++;
    }
    console.log(`[mcp] Server '${config.name}': ${added} tools discovered, ${this.mcpStubs.size} total stubs`);
    return added;
  }

  async refreshMcpServer(serverName: string): Promise<number> {
    const client = this.mcpClients.get(serverName);
    if (!client) return 0;
    try {
      await client.refreshTools();
      for (const stub of client.getTools()) {
        const key = `mcp:${serverName}:${stub.name}`;
        if (!this.mcpStubs.has(key)) this.mcpStubs.set(key, stub);
      }
    } catch { /* server may be down */ }
    return this.mcpStubs.size;
  }

  removeMcpServer(serverName: string): void {
    const client = this.mcpClients.get(serverName);
    client?.close();
    this.mcpClients.delete(serverName);
    for (const [key] of this.mcpStubs) {
      if (key.startsWith(`mcp:${serverName}:`)) this.mcpStubs.delete(key);
    }
    for (const [key] of this.activeSet) {
      if (key.startsWith(`mcp:${serverName}:`)) this.activeSet.delete(key);
    }
  }

  // ── Per-turn active set selection ──
  advanceTurn(prompt: string, remainingTokenBudget: number): ActiveToolEntry[] {
    this.currentTurn++;

    // Demote stale MCP tools
    for (const [key, entry] of this.activeSet) {
      if (entry.source.startsWith("mcp:")
          && this.currentTurn > entry.pinnedUntilTurn
          && this.currentTurn - entry.lastUsedTurn > this.MCP_TOOL_STALE_AFTER) {
        this.activeSet.delete(key);
      }
    }

    // Ensure minimum built-in slots
    let builtInActive = 0;
    for (const name of this.activeSet.keys()) {
      if (this.builtIn.has(name)) builtInActive++;
    }
    if (builtInActive < this.MIN_BUILTIN_SLOTS) {
      for (const [name, entry] of this.builtIn) {
        if (!this.activeSet.has(name)) {
          this.activeSet.set(name, entry);
          builtInActive++;
          if (builtInActive >= this.MIN_BUILTIN_SLOTS) break;
        }
      }
    }

    // Score MCP stubs and promote top hits
    const scored = this.scoreMcpStubs(prompt);
    const tokensPerTool = 350;

    for (const { key, score } of scored) {
      if (this.activeSet.size >= this.MAX_ACTIVE_TOOLS) break;
      const projected = (this.activeSet.size + 1) * tokensPerTool;
      if (remainingTokenBudget > 0 && projected > remainingTokenBudget * 0.15) break;

      const stub = this.mcpStubs.get(key);
      if (!stub || this.activeSet.has(key)) continue;

      this.activeSet.set(key, {
        name: stub.name,
        description: stub.description,
        argsSchema: stub.inputSchema,
        source: `mcp:${stub.serverName}`,
        lastUsedTurn: this.currentTurn,
        pinnedUntilTurn: this.currentTurn + this.MCP_PROMOTION_LOCK,
        searchScore: score,
      });
    }

    return [...this.activeSet.values()];
  }

  // ── 6-signal relevance scoring ──
  private scoreMcpStubs(prompt: string): Array<{ key: string; score: number }> {
    const promptLower = prompt.toLowerCase();
    const promptTokens = new Set(promptLower.split(/[^a-z0-9_./-]+/).filter((t) => t.length > 2));

    const results: Array<{ key: string; score: number }> = [];

    for (const [key, stub] of this.mcpStubs) {
      if (this.activeSet.has(key)) continue;
      let score = 0;
      const nameLower = stub.name.toLowerCase();
      const descLower = stub.description.toLowerCase();

      // Signal 1: Name match (4x)
      for (const token of promptTokens) {
        if (nameLower.includes(token)) score += 4;
      }
      // Signal 2: Description match (1x)
      for (const token of promptTokens) {
        if (descLower.includes(token)) score += 1;
      }
      // Signal 3: Recency boost
      const existing = [...this.activeSet.values()].find((e) => e.name === stub.name);
      if (existing && existing.lastUsedTurn > 0) {
        const recency = this.currentTurn - existing.lastUsedTurn;
        if (recency < 3) score += 3;
        else if (recency < 6) score += 1;
      }
      // Signal 4: Phase-based boost
      if (/\b(test|verify|assert|spec)\b/i.test(prompt)) {
        if (/\b(test|spec|assert)\b/i.test(nameLower + descLower)) score += 2;
      }
      if (/\b(install|deploy|publish|release)\b/i.test(prompt)) {
        if (/\b(deploy|publish|release|npm|docker)\b/i.test(nameLower + descLower)) score += 2;
      }
      if (/\b(database|query|sql|migration|schema)\b/i.test(prompt)) {
        if (/\b(database|sql|db|query|migration|prisma)\b/i.test(nameLower + descLower)) score += 2;
      }
      // Signal 5: Error recovery — check for failure signals in prompt
      if (/\b(error|fail|fix|repair|broken)\b/i.test(prompt)) {
        if (/\b(fix|repair|audit|clean|reset)\b/i.test(nameLower + descLower)) score += 3;
      }
      // Signal 6: Explicit mention (10x)
      const escapedName = stub.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${escapedName}\\b`, "i").test(prompt)) score += 10;

      if (score > 0) results.push({ key, score });
    }
    return results.sort((a, b) => b.score - a.score);
  }

  markUsed(toolName: string): void {
    for (const entry of this.activeSet.values()) {
      if (entry.name === toolName) { entry.lastUsedTurn = this.currentTurn; return; }
    }
    for (const entry of this.builtIn.values()) {
      if (entry.name === toolName) { entry.lastUsedTurn = this.currentTurn; return; }
    }
  }

  getActiveSet(): ActiveToolEntry[] { return [...this.activeSet.values()]; }
  getActiveToolNames(): string[] { return [...this.activeSet.values()].map((e) => e.name); }

  getSchema(name: string): unknown {
    const entry = this.activeSet.get(name);
    if (entry) return entry.argsSchema;
    for (const [key, stub] of this.mcpStubs) {
      if (stub.name === name) return stub.inputSchema;
    }
    return undefined;
  }

  async executeMcpTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    for (const entry of this.activeSet.values()) {
      if (entry.name === name && entry.source.startsWith("mcp:")) {
        const serverName = entry.source.slice(4);
        const client = this.mcpClients.get(serverName);
        if (client) return client.callTool(name, args);
      }
    }
    throw new Error(`No MCP server found for tool '${name}'`);
  }

  getStats(): { builtIn: number; mcpStubs: number; active: number; mcpActive: number } {
    let mcpActive = 0;
    for (const entry of this.activeSet.values()) {
      if (entry.source.startsWith("mcp:")) mcpActive++;
    }
    return { builtIn: this.builtIn.size, mcpStubs: this.mcpStubs.size, active: this.activeSet.size, mcpActive };
  }

  isMcpTool(name: string): boolean {
    for (const entry of this.activeSet.values()) {
      if (entry.name === name && entry.source.startsWith("mcp:")) return true;
    }
    return false;
  }
}
