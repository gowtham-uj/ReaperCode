import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const McpServerConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stdio"),
    name: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    autoDiscover: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("http"),
    name: z.string().min(1),
    url: z.string().min(1),
    autoDiscover: z.boolean().default(true),
  }),
]);
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const McpConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxActiveMCPTools: z.number().int().min(0).max(10).default(6),
  refreshIntervalTurns: z.number().int().min(1).default(10),
  servers: z.array(McpServerConfigSchema).default([]),
});
export type McpConfig = z.infer<typeof McpConfigSchema>;

export function loadMcpServersFromFile(workspaceRoot: string): McpServerConfig[] {
  for (const name of ["mcp.json", ".cursor/mcp.json"]) {
    try {
      const raw = readFileSync(join(workspaceRoot, ".reaper", name), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.mcpServers && typeof parsed.mcpServers === "object") {
        return Object.entries(parsed.mcpServers).map(([name, cfg]: [string, any]) => ({
          type: "stdio" as const,
          name: name,
          command: cfg.command ?? "npx",
          args: cfg.args ?? [],
          env: cfg.env,
          autoDiscover: true,
        }));
      }
    } catch { /* file doesn't exist */ }
  }
  return [];
}
