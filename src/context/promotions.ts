/**
 * context/promotions.ts — OMP port: track model promotions per run.
 *
 * In OMP, when a long-running loop crosses the context threshold, the
 * auto-compaction path first tries to promote to a larger-context
 * sibling model before compacting. The wiring emits
 * `promoted_context_model` events for every strict-upgrade sibling it
 * sees. This module persists the most recent promotion per runId so
 * the engine can swap the active mainAgent role on the next model
 * call.
 *
 * Storage: `.reaper/promotions/<runId>.jsonl` — one JSON per line,
 * most-recent first. We only ever need the *latest* promotion, so
 * the engine reads with `readRecentPromotions(runId, 1)`.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile, readFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ModelRoleInputSchema } from "../model/types.js";

export interface ModelPromotion {
  runId: string;
  sessionId: string;
  timestamp: string;
  /**
   * Role name of the active profile BEFORE the promotion
   * (e.g. "default_model"). The engine uses this to know which
   * modelRouting entry was in use.
   */
  fromRole: string;
  /**
   * Model id of the active profile before promotion. For
   * diagnostic display only — the engine uses `fromRole` to
   * actually switch routing.
   */
  fromProfile: string;
  fromContextTokens: number;
  /**
   * Role name to promote INTO (e.g. "secondary_model"). The
   * engine reads this to know which modelRouting entry to
   * swap to. This is the canonical #21 wire signal.
   */
  toRole: string;
  /**
   * Model id of the promoted profile. Diagnostic only — the
   * role-name is what the engine consumes.
   */
  toProfile: string;
  toContextTokens: number;
  ratioTrigger: number;
  /** Optional: name of the softCap that triggered the promotion. */
  softCap?: number;
}

/**
 * Zod schema for `ModelPromotion`. The on-disk JSONL file is
 * parseable via `ModelPromotionSchema.parse(JSON.parse(line))`,
 * and `readRecentPromotions*` returns validated records.
 *
 * `fromRole` and `toRole` are canonical role names that must
 * resolve via `ModelRoleInputSchema` (which accepts both the
 * canonical `secondary_model` and the legacy aliases
 * `main_reasoner`/`main_agent`/`strong_model`). The schema uses
 * `ModelRoleInputSchema` so older on-disk files that were
 * written before the rename still parse.
 */
export const ModelPromotionSchema = z.object({
  runId: z.string().min(1),
  sessionId: z.string().min(1),
  timestamp: z.string().min(1),
  fromRole: ModelRoleInputSchema,
  fromProfile: z.string().min(1),
  fromContextTokens: z.number().int().min(0),
  toRole: ModelRoleInputSchema,
  toProfile: z.string().min(1),
  toContextTokens: z.number().int().min(0),
  ratioTrigger: z.number().min(0).max(10),
  softCap: z.number().int().min(0).optional(),
}).strict();

function promotionsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".reaper", "promotions");
}

function promotionsPath(workspaceRoot: string, runId: string): string {
  return path.join(promotionsDir(workspaceRoot), `${runId}.jsonl`);
}

export async function recordPromotion(
  workspaceRoot: string,
  promotion: ModelPromotion,
): Promise<void> {
  const dir = promotionsDir(workspaceRoot);
  await mkdir(dir, { recursive: true });
  const file = promotionsPath(workspaceRoot, promotion.runId);
  await appendFile(file, JSON.stringify(promotion) + "\n", "utf8");
}

export function readRecentPromotionsSync(
  workspaceRoot: string,
  runId: string,
  limit: number = 5,
): ModelPromotion[] {
  const file = promotionsPath(workspaceRoot, runId);
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf8");
  const lines = raw.trim().split("\n").filter(Boolean);
  const out: ModelPromotion[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
    try {
      // Validate against the Zod schema. Records that don't match
      // (e.g. legacy on-disk files without `fromRole`/`toRole`) are
      // skipped. This is intentional: the engine only consumes
      // schema-compliant records.
      const parsed = ModelPromotionSchema.safeParse(JSON.parse(lines[i]!));
      if (parsed.success) {
        out.push(parsed.data as ModelPromotion);
      }
    } catch {
      // skip malformed line
    }
  }
  return out;
}

export async function readRecentPromotions(
  workspaceRoot: string,
  runId: string,
  limit: number = 5,
): Promise<ModelPromotion[]> {
  const file = promotionsPath(workspaceRoot, runId);
  if (!existsSync(file)) return [];
  try {
    const raw = await readFile(file, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const out: ModelPromotion[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
      try {
        const parsed = ModelPromotionSchema.safeParse(JSON.parse(lines[i]!));
        if (parsed.success) {
          out.push(parsed.data as ModelPromotion);
        }
      } catch {
        // skip malformed
      }
    }
    return out;
  } catch {
    return [];
  }
}
