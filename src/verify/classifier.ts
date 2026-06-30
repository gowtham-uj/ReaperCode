export type VerificationFailureKind = "deterministic" | "non_deterministic";

const nonDeterministicPatterns = [
  /timed out/i,
  /eaddrinuse/i,
  /enotempty/i,
  /ecconn?reset/i,
  /signal/i,
  /killed/i,
  /terminated/i,
  /resource temporarily unavailable/i,
];

export function classifyVerificationFailure(output: string): VerificationFailureKind {
  return nonDeterministicPatterns.some((pattern) => pattern.test(output)) ? "non_deterministic" : "deterministic";
}

export function shouldPromoteNonDeterministicFailure(recentFailureKinds: VerificationFailureKind[], threshold = 3): boolean {
  if (recentFailureKinds.length < threshold) {
    return false;
  }
  const tail = recentFailureKinds.slice(-threshold);
  return tail.every((kind) => kind === "non_deterministic");
}
