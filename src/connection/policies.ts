import { z } from "zod";

import { parseRequestReferences } from "./attachments.js";
import { type AgentRequestEnvelope } from "./schemas.js";
import { ConnectionPolicyError } from "./errors.js";

export const ConnectionPoliciesSchema = z
  .object({
    auth: z
      .object({
        allowAnonymous: z.boolean().default(true),
        bearerTokens: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .default({ allowAnonymous: true, bearerTokens: [] }),
    rateLimit: z
      .object({
        maxRequests: z.number().int().positive().default(60),
        windowMs: z.number().int().positive().default(60_000),
      })
      .strict()
      .default({ maxRequests: 60, windowMs: 60_000 }),
    maxPayloadBytes: z.number().int().positive().default(64 * 1024),
    requestTimeoutMs: z.number().int().positive().default(30_000),
    maxAttachments: z.number().int().nonnegative().default(8),
    maxArtifactRefs: z.number().int().nonnegative().default(8),
  })
  .strict();

export type ConnectionPolicies = z.infer<typeof ConnectionPoliciesSchema>;

export interface Clock {
  now(): number;
}

export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
    private readonly clock: Clock,
  ) {}

  consume(key: string): void {
    const now = this.clock.now();
    const existing = this.buckets.get(key);

    if (!existing || now - existing.startedAt >= this.windowMs) {
      this.buckets.set(key, { startedAt: now, count: 1 });
      return;
    }

    if (existing.count >= this.maxRequests) {
      throw new ConnectionPolicyError("Connection rate limit exceeded", "RATE_LIMITED");
    }

    existing.count += 1;
  }
}

export function parseConnectionPolicies(input: unknown): ConnectionPolicies {
  return ConnectionPoliciesSchema.parse(input ?? {});
}

export function enforceConnectionPolicies(
  request: AgentRequestEnvelope,
  policies: ConnectionPolicies,
  rateLimiter: InMemoryRateLimiter,
): void {
  enforceAuth(request, policies);
  enforcePayloadSize(request, policies.maxPayloadBytes);
  enforceReferences(request, policies.maxAttachments, policies.maxArtifactRefs);
  rateLimiter.consume(request.connection_id);
}

function enforceAuth(request: AgentRequestEnvelope, policies: ConnectionPolicies): void {
  const rawHeader = request.metadata.authorization;
  const authHeader = typeof rawHeader === "string" ? rawHeader : undefined;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;

  if (policies.auth.allowAnonymous && policies.auth.bearerTokens.length === 0) {
    return;
  }

  if (!token) {
    throw new ConnectionPolicyError("Bearer token required", "AUTH_REQUIRED");
  }

  if (!policies.auth.bearerTokens.includes(token)) {
    throw new ConnectionPolicyError("Invalid bearer token", "AUTH_INVALID");
  }
}

function enforcePayloadSize(request: AgentRequestEnvelope, maxPayloadBytes: number): void {
  const encoded = new TextEncoder().encode(JSON.stringify(request));
  if (encoded.byteLength > maxPayloadBytes) {
    throw new ConnectionPolicyError("Request payload exceeded maxPayloadBytes", "PAYLOAD_TOO_LARGE");
  }
}

function enforceReferences(request: AgentRequestEnvelope, maxAttachments: number, maxArtifactRefs: number): void {
  const parsed = parseRequestReferences({
    attachments: request.payload.attachments,
    artifactRefs: request.payload.artifactRefs,
  });

  if ((parsed.attachments?.length ?? 0) > maxAttachments) {
    throw new ConnectionPolicyError("Too many attachments", "TOO_MANY_ATTACHMENTS");
  }

  if ((parsed.artifactRefs?.length ?? 0) > maxArtifactRefs) {
    throw new ConnectionPolicyError("Too many artifact references", "TOO_MANY_ARTIFACT_REFS");
  }
}
