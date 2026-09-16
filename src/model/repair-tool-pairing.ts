/**
 * Keep every `tool_calls` entry paired with a matching tool message.
 *
 * OpenAI-compatible providers reject a request outright when an assistant
 * message announces tool calls and the following messages do not answer each
 * one:
 *
 *   HTTP 400 — An assistant message with 'tool_calls' must be followed by
 *   tool messages responding to each 'tool_call_id'.
 *   (insufficient tool messages following tool_calls message)
 *
 * The conversation Reaper sends is assembled by several passes that each
 * reshape the message list: rehydration from the session journal, compactors,
 * supersede-pruning, tool-history folding. Any one of them can remove a tool
 * message and leave its assistant announcement behind, and each has to
 * independently remember an invariant that belongs to the provider protocol
 * rather than to any of them.
 *
 * So the repair runs once, at the boundary where a `GenerateRequest` is about
 * to be dispatched, and applies the invariant to whatever those passes
 * produced. A pass that drops a tool result no longer has to compensate: the
 * orphan is repaired here rather than shipped.
 *
 * The observed case that motivated it: history rehydrated from the journal
 * filtered messages with `content.trim().length > 0 || tool_calls`, which
 * removes a tool result whose output is empty while keeping the assistant
 * message that called it. Sending a message after toggling a tool in Settings
 * was enough to produce it, and the user saw a provider error naming a
 * protocol rule rather than anything about their conversation.
 *
 * The repair has to be conservative in both directions, because the two ways
 * to satisfy the invariant are not equally safe:
 *
 *  - An assistant `tool_calls` entry with no answering tool message gets a
 *    synthetic result saying so. Dropping the announcement instead would
 *    rewrite history the model wrote, and could delete the only record that
 *    it asked for something.
 *  - A tool message with no announcing assistant message is dropped. It
 *    cannot be repaired by inventing a call, and a tool result the provider
 *    cannot attribute is itself rejected.
 */

/** The subset of a message this module reasons about. */
interface MessageLike {
  role: string;
  content?: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
}

export interface RepairResult<T> {
  messages: T[];
  /** Assistant tool calls that had no answering tool message. */
  synthesised: Array<{ toolCallId: string; toolName: string }>;
  /** Tool messages dropped because nothing announced them. */
  dropped: number;
  /** Tool calls that arrived without an id and were assigned one. */
  idAssigned: number;
}

/**
 * The text a synthetic result carries.
 *
 * It has to read as a tool result to the model, because that is the slot it
 * occupies, and it has to be true. "No result was recorded" is both: it does
 * not claim the tool failed, and it does not claim it succeeded, because the
 * repair cannot know which. A model that reads it can re-issue the call, which
 * is the right next move in every case this fires.
 */
function placeholderText(toolName: string): string {
  return (
    `No result was recorded for this call to \`${toolName}\`. ` +
    "Its output is not in the conversation, either because the call did not complete " +
    "or because the result was removed while trimming history. If you still need it, call it again."
  );
}

/**
 * Repair tool-call pairing in `messages`.
 *
 * Pure: returns a new array and never mutates its input. Passes that share a
 * message array rely on that, and a repair that edited in place would be
 * visible to whichever pass ran next.
 */
export function repairToolCallPairing<T extends MessageLike>(messages: readonly T[]): RepairResult<T> {
  const out: T[] = [];
  let dropped = 0;
  let idAssigned = 0;
  const synthesised: Array<{ toolCallId: string; toolName: string }> = [];

  /*
   * The calls announced by the most recent assistant message, in the order it
   * announced them, each with whether a result has answered it yet. Reset on
   * each assistant message that announces calls, because a provider pairs
   * within the run of messages that follows one assistant turn, not across the
   * whole conversation.
   */
  let pending: Array<{ id: string; name: string }> | null = null;
  /*
   * Counter for ids assigned to tool calls that arrived without one. Scoped to
   * this repair pass so the ids cannot collide with each other; a real id from
   * the provider is never touched.
   */
  let nextSyntheticCallId = 0;

  const synthesise = (call: { id: string; name: string }): void => {
    synthesised.push({ toolCallId: call.id, toolName: call.name });
    out.push({
      role: "tool",
      content: placeholderText(call.name),
      tool_call_id: call.id,
      name: call.name,
      is_error: true,
    } as unknown as T);
  };

  /*
   * Results the current batch has received, keyed by call id.
   *
   * Buffered rather than emitted on arrival so the batch is resolved as a
   * whole. The previous version emitted each result as it came and, when a
   * result arrived out of announcement order, filled the gap with a synthetic
   * result immediately — but a call whose real result is merely *later* in the
   * same batch is not missing. A batch announcing `c0..c5` whose results arrive
   * `c0,c1,c2,c4,c5,c3` therefore got a synthetic `c3` inserted before `c4`,
   * and the real `c3` that followed became an orphan with nothing announcing
   * it — the exact "tool must be a response to a preceding message with
   * tool_calls" rejection the repair exists to prevent, created by the repair.
   *
   * Buffering removes the guess: at flush, a call with a buffered result emits
   * that result and a call without one is synthesised, so a call is answered
   * exactly once and only when its answer truly never came.
   */
  let received: Map<string, T> | null = null;

  const flushRemaining = (): void => {
    if (!pending) return;
    /*
     * Emitted in announcement order, which is why the results were buffered
     * rather than pushed straight through: `[result-a, result-c]` for calls
     * `[a, b, c]` flushes as `a, b(synthetic), c`, so a provider that requires
     * results in call order gets them in call order.
     */
    for (const entry of pending) {
      const buffered = received?.get(entry.id);
      if (buffered !== undefined) {
        out.push(buffered);
      } else {
        synthesise(entry);
      }
    }
    pending = null;
    received = null;
  };

  for (const message of messages) {
    if (message.role === "assistant") {
      // Anything still unanswered when the next assistant turn begins never
      // arrived, so it is repaired before this message is emitted.
      flushRemaining();
      const rawCalls = message.tool_calls ?? [];
      /*
       * Give every announced call an id before deciding what to do with it.
       *
       * A call with no id is unanswerable: the provider has nothing to match a
       * `tool` message against, so it rejects the entire request — DeepSeek
       * reports it as "Messages with role 'tool' must be a response to a
       * preceding message with 'tool_calls'". The old code only checked for an
       * id when building `pending`, then pushed the assistant message
       * unchanged, so an id-less call was serialized with no id and no answer
       * and the request failed. Worse, `pairingWasRepaired` returned false for
       * that input, so the gateway passed it through believing it was fine.
       *
       * Assigning a synthetic id makes the call answerable, and it is then
       * treated exactly like any other announced call: if a result arrives it
       * pairs, and if none does the synthesise path below answers it. The
       * assistant message is re-emitted with the assigned ids so the wire and
       * the pending list agree.
       */
      let emitted = message;
      if (rawCalls.length > 0) {
        let rewrote = false;
        const normalizedCalls = rawCalls.map((call) => {
          if (typeof call?.id === "string" && call.id.length > 0) return call;
          rewrote = true;
          nextSyntheticCallId += 1;
          idAssigned += 1;
          return { ...(call ?? {}), id: `reaper-synthetic-call-${nextSyntheticCallId}` };
        });
        if (rewrote) emitted = { ...message, tool_calls: normalizedCalls } as T;
      }
      const calls = ((emitted as { tool_calls?: MessageLike["tool_calls"] }).tool_calls ?? []).filter(
        (call): call is { id: string; function?: { name?: string } } => typeof call?.id === "string" && call.id.length > 0,
      );
      if (calls.length > 0) {
        pending = calls.map((call) => ({ id: call.id, name: call.function?.name ?? "tool" }));
        received = new Map();
      }
      out.push(emitted);
      continue;
    }

    if (message.role === "tool") {
      const id = typeof message.tool_call_id === "string" ? message.tool_call_id : "";
      /*
       * Two ways a tool message can fail to belong: no id at all, or an id
       * nothing announced. Both are unusable to the provider, and neither can
       * be repaired by inventing the missing call.
       */
      if (!pending || !received || !pending.some((call) => call.id === id)) {
        dropped += 1;
        continue;
      }
      /*
       * Buffered, not emitted. A second result for a call already answered is
       * impossible here — the batch is resolved once at flush — so the map
       * holds at most one entry per announced call.
       */
      received.set(id, message);
      continue;
    }

    // A user or system message ends the pairing run. Anything unanswered
    // before it is repaired, or the ids would be attributed to whatever
    // assistant turn comes later.
    flushRemaining();
    out.push(message);
  }

  flushRemaining();
  return { messages: out, synthesised, dropped, idAssigned };
}

/**
 * Whether the repair changed anything.
 *
 * The caller uses this to decide whether to keep the repaired array or the
 * original, so a well-formed conversation is passed through untouched rather
 * than copied. Derived from the repair's own counters rather than a second
 * scan, because two implementations of the same predicate drift apart and the
 * one that is wrong is always the one that says "nothing to do".
 */
export function pairingWasRepaired<T>(result: RepairResult<T>): boolean {
  return result.synthesised.length > 0 || result.dropped > 0 || result.idAssigned > 0;
}
