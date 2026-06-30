import {
  ConnectionPolicyError,
  ConnectionTimeoutError,
  SessionNotFoundError,
} from "./errors.js";
import { enforceConnectionPolicies, InMemoryRateLimiter, parseConnectionPolicies, type Clock } from "./policies.js";
import { type AgentEventEnvelope, type AgentRequestEnvelope, type TransportKind } from "./schemas.js";
import { QueryGuard, ReentrantQueryError } from "../runtime/query-guard.js";

export interface SessionSnapshot {
  sessionId: string;
  turnId: string;
  status: "idle" | "running" | "completed" | "cancelled" | "error";
  updatedAt: string;
  lastRequestId?: string;
  lastEvents: AgentEventEnvelope[];
}

export interface AgentTurnContext {
  signal: AbortSignal;
  session: SessionSnapshot;
  transport: TransportKind;
}

export type AgentTurnHandler = (
  request: AgentRequestEnvelope,
  context: AgentTurnContext,
) => AsyncIterable<AgentEventEnvelope> | Promise<AsyncIterable<AgentEventEnvelope>>;

export interface SessionGatewayResponse {
  sessionId: string;
  requestId: string;
  status: "completed" | "cancelled" | "resumed" | "error";
  events: AgentEventEnvelope[];
  resumed: boolean;
}

interface SessionRecord {
  snapshot: SessionSnapshot;
  activeAbort?: AbortController;
}

class RequestAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestAbortedError";
  }
}

const systemClock: Clock = {
  now: () => Date.now(),
};

export class SessionGateway {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly rateLimiter;
  private readonly queryGuard = new QueryGuard();

  constructor(
    private readonly handler: AgentTurnHandler,
    private readonly policies = parseConnectionPolicies({}),
    private readonly clock: Clock = systemClock,
  ) {
    this.rateLimiter = new InMemoryRateLimiter(policies.rateLimit.maxRequests, policies.rateLimit.windowMs, clock);
  }

  async handleRequest(request: AgentRequestEnvelope, transport: TransportKind): Promise<SessionGatewayResponse> {
    enforceConnectionPolicies(request, this.policies, this.rateLimiter);

    if (request.message_type === "session_resume") {
      const session = this.sessions.get(request.session_id);
      if (!session) {
        throw new SessionNotFoundError(request.session_id);
      }

      const offsetRaw = request.payload.event_offset;
      const eventOffset = typeof offsetRaw === "number" && Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

      session.snapshot.updatedAt = new Date(this.clock.now()).toISOString();
      return {
        sessionId: session.snapshot.sessionId,
        requestId: request.request_id,
        status: "resumed",
        events: session.snapshot.lastEvents.slice(eventOffset),
        resumed: true,
      };
    }

    if (request.message_type === "cancel_request" || request.message_type === "abort_execution") {
      const session = this.sessions.get(request.session_id);
      if (!session?.activeAbort) {
        throw new SessionNotFoundError(request.session_id);
      }

      session.activeAbort.abort(request.message_type);
      const event = this.createSystemEvent(request, "error", {
        code: request.message_type === "cancel_request" ? "REQUEST_CANCELLED" : "EXECUTION_ABORTED",
        message: request.message_type === "cancel_request" ? "Active request cancelled" : "Execution aborted",
      });
      session.snapshot.status = "cancelled";
      session.snapshot.lastEvents = [event];
      session.snapshot.updatedAt = new Date(this.clock.now()).toISOString();

      return {
        sessionId: request.session_id,
        requestId: request.request_id,
        status: "cancelled",
        events: [event],
        resumed: false,
      };
    }

    const session = this.getOrCreateSession(request);
    const abortController = new AbortController();
    session.activeAbort = abortController;
    session.snapshot.status = "running";
    session.snapshot.lastRequestId = request.request_id;
    session.snapshot.updatedAt = new Date(this.clock.now()).toISOString();

    let guardGen: number;
    try {
      guardGen = this.queryGuard.start();
    } catch (error) {
      if (error instanceof ReentrantQueryError) {
        const event = this.createSystemEvent(request, "error", { code: "REENTRANT_QUERY", message: error.message });
        session.snapshot.status = "error";
        session.snapshot.lastEvents = [event];
        return {
          sessionId: request.session_id,
          requestId: request.request_id,
          status: "error",
          events: [event],
          resumed: false,
        };
      }
      throw error;
    }

    try {
      this.queryGuard.markRunning(guardGen);
      const iterable = await this.handler(request, {
        signal: abortController.signal,
        session: { ...session.snapshot },
        transport,
      });
      const events = await this.collectEvents(iterable, request, abortController);
      session.snapshot.status = "completed";
      session.snapshot.lastEvents = events;
      session.snapshot.updatedAt = new Date(this.clock.now()).toISOString();

      return {
        sessionId: request.session_id,
        requestId: request.request_id,
        status: "completed",
        events,
        resumed: false,
      };
    } catch (error) {
      const event = this.createSystemEvent(request, "error", this.mapError(error));
      session.snapshot.status = abortController.signal.aborted ? "cancelled" : "error";
      session.snapshot.lastEvents = [event];
      session.snapshot.updatedAt = new Date(this.clock.now()).toISOString();

      return {
        sessionId: request.session_id,
        requestId: request.request_id,
        status: abortController.signal.aborted ? "cancelled" : "error",
        events: [event],
        resumed: false,
      };
    } finally {
      this.queryGuard.finish(guardGen);
      if (session.activeAbort === abortController) {
        delete session.activeAbort;
      }
    }
  }

  private getOrCreateSession(request: AgentRequestEnvelope): SessionRecord {
    const existing = this.sessions.get(request.session_id);
    if (existing) {
      existing.snapshot.turnId = request.turn_id;
      return existing;
    }

    const record: SessionRecord = {
      snapshot: {
        sessionId: request.session_id,
        turnId: request.turn_id,
        status: "idle",
        updatedAt: new Date(this.clock.now()).toISOString(),
        lastRequestId: request.request_id,
        lastEvents: [],
      },
    };
    this.sessions.set(request.session_id, record);
    return record;
  }

  private async collectEvents(
    iterable: AsyncIterable<AgentEventEnvelope>,
    request: AgentRequestEnvelope,
    abortController: AbortController,
  ): Promise<AgentEventEnvelope[]> {
    const iterator = iterable[Symbol.asyncIterator]();
    const events: AgentEventEnvelope[] = [];
    const timeout = this.policies.requestTimeoutMs;

    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abortCleanup: (() => void) | undefined;
      let timedOut = false;

      try {
        const step = await Promise.race([
          iterator.next(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              abortController.abort("timeout");
              reject(new ConnectionTimeoutError());
            }, timeout);

            const onAbort = () => {
              reject(timedOut ? new ConnectionTimeoutError() : new RequestAbortedError("Request cancelled"));
            };
            abortController.signal.addEventListener("abort", onAbort, { once: true });
            abortCleanup = () => abortController.signal.removeEventListener("abort", onAbort);
          }),
        ]);

        if (step.done) {
          break;
        }

        events.push(this.normalizeEvent(step.value, request));
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
        abortCleanup?.();
      }
    }

    return events;
  }

  private normalizeEvent(event: AgentEventEnvelope, request: AgentRequestEnvelope): AgentEventEnvelope {
    return {
      ...event,
      connection_id: request.connection_id,
      session_id: request.session_id,
      turn_id: request.turn_id,
      request_id: request.request_id,
      trace_id: request.trace_id,
    };
  }

  private createSystemEvent(
    request: AgentRequestEnvelope,
    messageType: AgentEventEnvelope["message_type"],
    payload: Record<string, unknown>,
  ): AgentEventEnvelope {
    return {
      connection_id: request.connection_id,
      session_id: request.session_id,
      turn_id: request.turn_id,
      request_id: request.request_id,
      message_type: messageType,
      timestamp: new Date(this.clock.now()).toISOString(),
      trace_id: request.trace_id,
      payload,
      metadata: {},
    };
  }

  private mapError(error: unknown): Record<string, unknown> {
    if (error instanceof ConnectionTimeoutError) {
      return { code: "REQUEST_TIMEOUT", message: error.message };
    }

    if (error instanceof RequestAbortedError) {
      return { code: "REQUEST_CANCELLED", message: error.message };
    }

    if (error instanceof ConnectionPolicyError) {
      return { code: error.code, message: error.message };
    }

    if (error instanceof Error) {
      return { code: "REQUEST_FAILED", message: error.message };
    }

    return { code: "REQUEST_FAILED", message: "Unknown request failure" };
  }
}
