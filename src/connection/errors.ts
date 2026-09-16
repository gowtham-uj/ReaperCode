/**
 * The error type connection policy raises.
 *
 * This file held seven error classes and two helpers; one is still reachable.
 * The others (`ConnectionTimeoutError`, `SessionNotFoundError`,
 * `NoActiveTurnError`, `BadRequestError`, `toBadRequestError`,
 * `describeConnectionError`) belonged to the `src/connection/` transport
 * adapters, which nothing constructs any more — the app-server replaced that
 * layer, and its own protocol errors carry the same information with the code
 * names the clients actually read. Keeping them would be dead code that looks
 * maintained.
 *
 * `ConnectionPolicyError` stays because `policies.ts` throws it and policies
 * are still applied: the bearer-token, rate-limit, payload-size, and attachment
 * ceilings are all evaluated on the live path.
 */

export class ConnectionPolicyError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "AUTH_REQUIRED"
      | "AUTH_INVALID"
      | "RATE_LIMITED"
      | "PAYLOAD_TOO_LARGE"
      | "TOO_MANY_ATTACHMENTS"
      | "TOO_MANY_ARTIFACT_REFS",
  ) {
    super(message);
    this.name = "ConnectionPolicyError";
  }
}
