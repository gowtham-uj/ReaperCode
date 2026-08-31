import {
  BadRequestError,
  ConnectionPolicyError,
  ConnectionTimeoutError,
  NoActiveTurnError,
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

export interface SessionGatewayHandleOptions {
  /**
   * Called for each event as it is produced, enabling true incremental
   * streaming. May return a promise for backpressure. The terminal
   * cancel/error events synthesized by the gateway are also delivered here.
   */
  onEvent?: (event: AgentEventEnvelope) => void | Promise<void>;
}

interface SessionRecord {
  snapshot: SessionSnapshot;
  /** Re-entrancy guard scoped to this session so concurrent sessions don't collide. */
  guard: QueryGuard;
  activeAbort?: AbortController;
}

/** Upper bound on events retained per session for `session_resume` replay. */
const MAX_SESSION_EVENTS = 200;

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

  constructor(
    private readonly handler: AgentTurnHandler,
    private readonly policies = parseConnectionPolicies({}),
    private readonly clock: Clock = systemClock,
  ) {
    this.rateLimiter = new InMemoryRateLimiter(policies.rateLimit.maxRequests, policies.rateLimit.windowMs, clock);
  }

  async handleRequest(
    request: AgentRequestEnvelope,
    transport: TransportKind,
    options: SessionGatewayHandleOptions = {},
  ): Promise<SessionGatewayResponse> {
    enforceConnectionPolicies(request, this.policies, this.rateLimiter);

    if (request.message_type === "session_resume") {
      const session = this.sessions.get(request.session_id);
      if (!session) {
        throw new SessionNotFoundError(request.session_id);
      }

      const eventOffset = this.normalizeEventOffset(
        request.payload.event_offset,
        session.snapshot.lastEvents.length,
        request.session_id,
      );

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
      if (!session) {
        throw new SessionNotFoundError(request.session_id);
      }
      if (!session.activeAbort) {
        throw new NoActiveTurnError(request.session_id);
      }

      session.activeAbort.abort(request.message_type);
      const event = this.createSystemEvent(request, "error", {
        code: request.message_type === "cancel_request" ? "REQUEST_CANCELLED" : "EXECUTION_ABORTED",
        message: request.message_type === "cancel_request" ? "Active request cancelled" : "Execution aborted",
      });
      session.snapshot.status = "cancelled";
      this.appendEvents(session, [event]);
      session.snapshot.updatedAt = new Date(this.clock.now()).toISOString();
      await options.onEvent?.(event);

      return {
        sessionId: request.session_id,
        requestId: request.request_id,
        status: "cancelled",
        events: [event],
        resumed: false,
      };
    }

    const session = this.getOrCreateSession(request);

    let guardGen: number;
    try {
      guardGen = session.guard.start();
    } catch (error) {
      if (error instanceof ReentrantQueryError) {
        // Reject before touching session state so a rejected request never
        // clobbers the running turn's abort controller or status.
        const event = this.createSystemEvent(request, "error", { code: "REENTRANT_QUERY", message: error.message });
        this.appendEvents(session, [event]);
        await options.onEvent?.(event);
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

    const abortController = new AbortController();
    session.activeAbort = abortController;
    session.snapshot.status = "running";
    session.snapshot.lastRequestId = request.request_id;
    session.snapshot.updatedAt = new Date(this.clock.now()).toISOString();

    try {
      session.guard.markRunning(guardGen);
      const iterable = await this.handler(request, {
        signal: abortController.signal,
        session: { ...session.snapshot },
        transport,
      });
      const events = await this.collectEvents(iterable, request, abortController, async (event) => {
        // Commit partial events to history as they arrive so a cancel/error
        // mid-turn preserves everything emitted before the failure.
        this.appendEvents(session, [event]);
        await options.onEvent?.(event);
      });
      session.snapshot.status = "completed";
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
      this.appendEvents(session, [event]);
      session.snapshot.updatedAt = new Date(this.clock.now()).toISOString();
      await options.onEvent?.(event);

      return {
        sessionId: request.session_id,
        requestId: request.request_id,
        status: abortController.signal.aborted ? "cancelled" : "error",
        events: [event],
        resumed: false,
      };
    } finally {
      session.guard.finish(guardGen);
      if (session.activeAbort === abortController) {
        delete session.activeAbort;
      }
    }
  }

  /**
   * Stream a turn's events incrementally as the handler yields them, then
   * resolve with the final {@link SessionGatewayResponse}. This is the
   * streaming analogue of {@link handleRequest} — callers can
   * `for await (const event of gateway.streamRequest(request, transport))`.
   */
  async *streamRequest(
    request: AgentRequestEnvelope,
    transport: TransportKind,
  ): AsyncGenerator<AgentEventEnvelope, SessionGatewayResponse> {
    const queue: AgentEventEnvelope[] = [];
    const waiters: Array<() => void> = [];
    let final: SessionGatewayResponse | undefined;
    let failure: unknown;

    const notify = (): void => {
      while (waiters.length > 0) waiters.shift()!();
    };

    this.handleRequest(request, transport, {
      onEvent: (event) => {
        queue.push(event);
        notify();
      },
    }).then(
      (result) => {
        final = result;
        notify();
      },
      (error) => {
        failure = error;
        notify();
      },
    );

    while (true) {
      while (queue.length > 0) yield queue.shift()!;
      if (failure !== undefined) throw failure;
      if (final !== undefined) return final;
      await new Promise<void>((resolve) => waiters.push(resolve));
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
      guard: new QueryGuard(),
    };
    this.sessions.set(request.session_id, record);
    return record;
  }

  /** Append events to the session's bounded replay history instead of clobbering it. */
  private appendEvents(session: SessionRecord, events: AgentEventEnvelope[]): void {
    session.snapshot.lastEvents = session.snapshot.lastEvents.concat(events).slice(-MAX_SESSION_EVENTS);
  }

  private normalizeEventOffset(raw: unknown, total: number, sessionId: string): number {
    const offset = typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0;
    if (offset > total) {
      throw new BadRequestError(
        `event_offset ${offset} exceeds the ${total} retained event(s) for session '${sessionId}'`,
        "INVALID_EVENT_OFFSET",
      );
    }
    return offset;
  }

  private async collectEvents(
    iterable: AsyncIterable<AgentEventEnvelope>,
    request: AgentRequestEnvelope,
    abortController: AbortController,
    onEvent?: (event: AgentEventEnvelope) => void | Promise<void>,
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

        const normalized = this.normalizeEvent(step.value, request);
        events.push(normalized);
        await onEvent?.(normalized);
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
