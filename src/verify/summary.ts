import type { VerificationResult } from "./runner.js";

export interface VerificationSummary {
  attemptCount: number;
  passFail: "pass" | "fail";
  liteVerified: boolean;
  startedAt: string;
  endedAt: string;
}

export function createVerificationSummary(result: VerificationResult, attemptCount: number): VerificationSummary {
  return {
    attemptCount,
    passFail: result.ok ? "pass" : "fail",
    liteVerified: result.liteVerified,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
  };
}
