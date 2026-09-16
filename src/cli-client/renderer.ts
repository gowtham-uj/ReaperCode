/**
 * The terminal's view of a turn.
 *
 * Renders from the app-server's typed notifications rather than from raw model
 * output, and that is the whole fix. The old path wrote both reasoning and
 * answer through one stdout channel, distinguished only by `dim()` — which is a
 * no-op whenever stdout is not a colour TTY. Reasoning therefore appeared
 * interleaved into the answer, with nothing marking it, in every piped, logged,
 * or non-interactive run.
 *
 * Here the two arrive as different methods (`item/reasoning/textDelta` vs
 * `item/agentMessage/delta`), so the split is structural rather than cosmetic.
 * Colour is still used when the terminal supports it, but **it is never the
 * only signal**: a reasoning block gets a real `thinking` header on every
 * terminal, and the answer gets none. That is what makes the output correct
 * when piped to a file, which is how CI and most scripts read it.
 *
 * Labels come from `web/shared/src/summarize.ts`, the same vocabulary the web
 * transcript uses, so one call is described with one set of words on both
 * surfaces.
 */
import { summarizeContextRun, summarizeItem, toolLabel } from "../../web/shared/src/summarize.js";
import type { AppThreadItem } from "../../web/shared/src/types.js";
import { dim } from "../runtime/session-printer.js";

/**
 * Whether this stream can render ANSI.
 *
 * Local to the renderer rather than imported from `session-printer`, whose
 * version is private. Deliberately only ever used to *add* emphasis: every
 * distinction this file draws has a text form as well, so a stream that cannot
 * colour still reads correctly. That is the property the old path lacked.
 */
function canColour(out: NodeJS.WriteStream): boolean {
  const tty = out as unknown as { isTTY?: boolean; getColorDepth?: () => number };
  if (!tty.isTTY) return false;
  const depth = tty.getColorDepth?.();
  return depth !== undefined && depth > 1;
}

export interface RendererOptions {
  out?: NodeJS.WriteStream;
  /** Print reasoning blocks. Off drops them entirely rather than hiding them,
   *  which is what a user asking for a quiet run wants. */
  showReasoning?: boolean;
  /** Print one line per tool call. */
  showTools?: boolean;
}

/**
 * Renders notifications as they arrive.
 *
 * Stateful because a stream is a sequence: the header for a block prints once,
 * when the block opens, and the text then appends without repeating it. Doing
 * this per-notification with no state is what produced the old output, where
 * every delta was written as though it stood alone.
 */
export class TerminalRenderer {
  private readonly out: NodeJS.WriteStream;
  private readonly showReasoning: boolean;
  private readonly showTools: boolean;
  private readonly colour: boolean;
  /** Which block is open, so a header is printed on transition and not per
   *  delta. `undefined` means nothing is open. */
  private block: "reasoning" | "answer" | undefined;
  private answerStarted = false;

  constructor(options: RendererOptions = {}) {
    this.out = options.out ?? (process.env.REAPER_STREAM_EVENTS === "1" ? process.stderr : process.stdout);
    this.showReasoning = options.showReasoning ?? true;
    this.showTools = options.showTools ?? true;
    // Resolved once at construction: the stream's capabilities do not change
    // mid-run, and asking per write is a syscall per delta.
    this.colour = canColour(this.out);
  }

  /** One notification. Unknown methods are ignored rather than printed, so a
   *  server that adds a method does not spray JSON into the transcript. */
  handle(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "item/reasoning/textDelta":
        if (typeof params.delta === "string") this.writeReasoning(params.delta);
        return;
      case "item/agentMessage/delta":
        if (typeof params.delta === "string") this.writeAnswer(params.delta);
        return;
      case "item/completed":
        this.writeItemCompleted(params.item as AppThreadItem | undefined);
        return;
      case "item/commandExecution/outputDelta":
        if (typeof params.delta === "string") this.writeCommandOutput(params.delta);
        return;
      case "error":
      case "warning": {
        const message = typeof params.message === "string" ? params.message : JSON.stringify(params);
        this.closeBlock();
        this.line(`${method === "error" ? "✕" : "!"} ${message}`);
        return;
      }
      default:
        return;
    }
  }

  /** Close any open block and print the final answer, for a run whose output
   *  only ever arrived as one completed item. */
  finish(): void {
    this.closeBlock();
  }

  private writeReasoning(text: string): void {
    if (!this.showReasoning) return;
    if (this.block !== "reasoning") {
      /*
       * A real header, not an indent and not a colour. This is the line that
       * makes the output honest when colour is unavailable: without it the
       * reasoning below is text the user reads as the agent's answer.
       */
      this.closeBlock();
      this.out.write(`\n  ■ thinking\n`);
      this.block = "reasoning";
    }
    this.out.write(this.tint(text));
  }

  private writeAnswer(text: string): void {
    if (this.block !== "answer") {
      this.closeBlock();
      if (this.answerStarted) this.out.write("\n");
      // Only label the answer when reasoning was actually shown, because
      // "answer" is the default and a header on every reply is noise. The
      // pairing is what disambiguates, not the label alone.
      if (this.showReasoning) this.out.write("  ■ answer\n");
      this.answerStarted = true;
      this.block = "answer";
    }
    this.out.write(text);
  }

  private writeCommandOutput(delta: string): void {
    // Command output is not the agent speaking, so it must not be mistaken for
    // prose. Indented and unstyled, which reads as a log either way.
    if (this.block === "answer") this.closeBlock();
    this.out.write(delta.replace(/^(?!$)/gm, "    "));
  }

  private writeItemCompleted(item: AppThreadItem | undefined): void {
    if (!item || !this.showTools) return;
    // Reasoning and the answer were already streamed delta by delta, and a
    // completed-message line on top of them would say it twice.
    if (item.type === "agentMessage" || item.type === "reasoning" || item.type === "userMessage") return;

    if (item.type === "contextManagement") {
      const summary = summarizeContextRun({
        technique: item.technique,
        status: item.status,
        ...(item.savedChars !== undefined ? { savedChars: item.savedChars } : {}),
        ...(item.savedTokens !== undefined ? { savedTokens: item.savedTokens } : {}),
        ...(item.messagesBefore !== undefined ? { messagesBefore: item.messagesBefore } : {}),
        ...(item.messagesAfter !== undefined ? { messagesAfter: item.messagesAfter } : {}),
      } as Parameters<typeof summarizeContextRun>[0]);
      if (summary) {
        this.closeBlock();
        this.line(`${this.tint("◆")} ${summary}`);
      }
      return;
    }

    const { label, detail } = summarizeItem(item);
    this.closeBlock();
    const mark = item.type === "commandExecution" && item.status === "failed" ? "✕" : this.tint("●");
    const name = item.type === "dynamicToolCall" ? toolLabel(item.tool) : label;
    this.line(`${mark} ${name}${detail ? `  ${detail}` : ""}`);
  }

  private closeBlock(): void {
    if (this.block === "answer") this.out.write("\n");
    if (this.block !== undefined) this.out.write("\n");
    this.block = undefined;
  }

  private line(text: string): void {
    this.out.write(`  ${text}\n`);
  }

  private tint(text: string): string {
    return this.colour ? `\x1b[2m${text}\x1b[0m` : text;
  }
}

export { dim };
