import { ZodError } from "zod";

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

/**
 * Thrown when a cancel/abort is requested for a session that exists but has
 * no active turn. Distinct from {@link SessionNotFoundError}, which means the
 * session itself is unknown.
 */
export class NoActiveTurnError extends Error {
  constructor(sessionId: string) {
    super(`Session '${sessionId}' has no active turn to cancel`);
    this.name = "NoActiveTurnError";
  }
}

/**
 * Thrown when a request fails validation before it can be dispatched (bad
 * envelope shape, out-of-range offsets, …). Maps to HTTP 400.
 */
export class BadRequestError extends Error {
  constructor(
    message: string,
    public readonly code = "BAD_REQUEST",
    public readonly issues?: unknown,
  ) {
    super(message);
    this.name = "BadRequestError";
  }
}

/** Normalize an arbitrary thrown value into a {@link BadRequestError}. */
export function toBadRequestError(error: unknown): BadRequestError {
  if (error instanceof BadRequestError) return error;
  if (error instanceof ZodError) {
    const details = error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
      .join("; ");
    return new BadRequestError(
      details ? `Invalid request envelope — ${details}` : "Invalid request envelope",
      "INVALID_REQUEST",
      error.issues,
    );
  }
  return new BadRequestError(error instanceof Error ? error.message : "Invalid request");
}

export interface ConnectionErrorInfo {
  status: number;
  code: string;
  message: string;
  issues?: unknown;
}

/** Shared mapping from thrown errors to a transport-independent error shape. */
export function describeConnectionError(error: unknown): ConnectionErrorInfo {
  if (error instanceof ConnectionPolicyError) {
    return { status: 403, code: error.code, message: error.message };
  }
  if (error instanceof SessionNotFoundError) {
    return { status: 404, code: "SESSION_NOT_FOUND", message: error.message };
  }
  if (error instanceof NoActiveTurnError) {
    return { status: 409, code: "NOTHING_TO_CANCEL", message: error.message };
  }
  if (error instanceof BadRequestError) {
    return {
      status: 400,
      code: error.code,
      message: error.message,
      ...(error.issues !== undefined ? { issues: error.issues } : {}),
    };
  }
  if (error instanceof ZodError) {
    return { status: 400, code: "INVALID_REQUEST", message: "Invalid request", issues: error.issues };
  }
  if (error instanceof ConnectionTimeoutError) {
    return { status: 504, code: "REQUEST_TIMEOUT", message: error.message };
  }
  return {
    status: 500,
    code: "REQUEST_FAILED",
    message: error instanceof Error ? error.message : "Unknown connection failure",
  };
}
