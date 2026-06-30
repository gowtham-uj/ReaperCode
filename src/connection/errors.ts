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

export class ConnectionTimeoutError extends Error {
  constructor(message = "Request timed out") {
    super(message);
    this.name = "ConnectionTimeoutError";
  }
}

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session '${sessionId}' not found`);
    this.name = "SessionNotFoundError";
  }
}
