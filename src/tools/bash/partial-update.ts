/**
 * Streaming bash output accumulator.
 *
 * Mirrors a small slice of the reference agent's incremental-output helper:
 * decode incoming byte chunks through a streaming UTF-8 decoder, keep only a
 * bounded rolling tail in memory for snapshot purposes, and persist a full
 * copy to a temp file as soon as the projected output exceeds the configured
 * limits. Snapshots are exposed via {@link BashOutputAccumulator.snapshot} so
 * downstream callers (model streaming, TUI partial renders) can re-render a
 * bounded tail without buffering the full output.
 *
 * The helper is deliberately reusable outside of the foreground-spill path so
 * callers that own the underlying `ChildProcess` stream (for example custom
 * `shellRunner` integrations) can hook the model or TUI into partial updates
 * without modifying {@link "../../tools/global/bash"}.
 */

import { randomBytes } from "node:crypto";
import { type WriteStream, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Default memory cap for the rolling tail window (bytes). */
const DEFAULT_MAX_BYTES = 50 * 1024;
/** Default cap on the number of lines retained for tail snapshots. */
const DEFAULT_MAX_LINES = 2000;

export interface BashOutputAccumulatorOptions {
  /** Maximum retained decoded bytes for the rolling tail. */
  maxBytes?: number;
  /** Maximum number of completed lines retained for tail snapshots. */
  maxLines?: number;
  /** Prefix for the temp file that holds the full output once thresholds trip. */
  tempFilePrefix?: string;
  /** Override path for the temp file (used by tests to inspect spill behavior). */
  tempFilePath?: string;
}

export interface BashOutputSnapshot {
  /** Bounded tail suitable for streaming into the model or TUI. */
  content: string;
  /** Whether the rolling window actually overflowed the configured limits. */
  truncated: boolean;
  /** Which limit triggered truncation: "bytes", "lines", or null. */
  truncatedBy: "bytes" | "lines" | null;
  totalBytes: number;
  totalLines: number;
  /** Absolute path to the temp file containing the full output, if one was opened. */
  fullOutputPath?: string;
}

interface TruncationLimits {
  maxBytes: number;
  maxLines: number;
}

function defaultTempFilePath(prefix: string): string {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), `${prefix}-${id}.log`);
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf-8");
}

function splitLinesForCounting(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

function truncateTailWithinLimits(content: string, limits: TruncationLimits): string {
  const lines = splitLinesForCounting(content);
  if (lines.length <= limits.maxLines && Buffer.byteLength(content, "utf-8") <= limits.maxBytes) {
    return content;
  }
  const out: string[] = [];
  let outBytes = 0;
  let truncation: "lines" | "bytes" | null = "lines";
  for (let i = lines.length - 1; i >= 0 && out.length < limits.maxLines; i--) {
    const line = lines[i] ?? "";
    const lineBytes = byteLength(line) + (out.length > 0 ? 1 : 0);
    if (outBytes + lineBytes > limits.maxBytes) {
      if (out.length === 0) {
        const tail = Buffer.from(line, "utf-8");
        let sliceStart = Math.max(0, tail.length - limits.maxBytes);
        while (sliceStart < tail.length && (tail[sliceStart]! & 0xc0) === 0x80) sliceStart++;
        const fragment = tail.subarray(sliceStart).toString("utf-8");
        out.unshift(fragment);
        outBytes = byteLength(fragment);
      }
      truncation = "bytes";
      break;
    }
    out.unshift(line);
    outBytes += lineBytes;
  }
  if (out.length >= limits.maxLines && outBytes <= limits.maxBytes) {
    truncation = "lines";
  }
  // `out` is unused below if we returned early above — narrow the type.
  void truncation;
  return out.join("\n");
}

export class BashOutputAccumulator {
  private readonly limits: TruncationLimits;
  private readonly tempFilePrefix: string;
  private readonly explicitTempFilePath: string | undefined;
  private readonly decoder = new TextDecoder();

  private rawChunks: Buffer[] = [];
  private tailText = "";
  private tailBytes = 0;
  private tailStartsAtLineBoundary = true;
  private totalRawBytes = 0;
  private totalDecodedBytes = 0;
  private completedLines = 0;
  private currentLineBytes = 0;
  private hasOpenLine = false;
  private finished = false;

  private tempFilePath: string | undefined;
  private tempFileStream: WriteStream | undefined;

  constructor(options: BashOutputAccumulatorOptions = {}) {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    this.limits = { maxBytes, maxLines };
    this.tempFilePrefix = options.tempFilePrefix ?? "reaper-bash";
    this.explicitTempFilePath = options.tempFilePath;
  }

  /**
   * Append a decoded or raw chunk of output.
   *
   * Strings are wrapped in Buffers so callers can mix `Buffer` chunks from a
   * `ChildProcess` and pre-decoded `string` payloads without forcing either
   * side to convert on every call.
   */
  append(chunk: Buffer | string): void {
    if (this.finished) {
      throw new Error("Cannot append to a finished bash output accumulator");
    }
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk;
    this.totalRawBytes += buf.length;
    this.appendDecodedText(this.decoder.decode(buf, { stream: true }));
    if (this.shouldUseTempFile()) {
      this.ensureTempFile();
      this.tempFileStream?.write(buf);
    } else if (buf.length > 0) {
      this.rawChunks.push(buf);
    }
  }

  /**
   * Mark the stream complete. Flushes any pending bytes from the streaming
   * UTF-8 decoder and finalises the full-output temp file (opening one on
   * demand if the projected output grew past the configured limits while
   * {@link append} was being called).
   */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    const flush = this.decoder.decode();
    if (flush.length > 0) {
      this.appendDecodedText(flush);
    }
    if (this.shouldUseTempFile()) {
      this.ensureTempFile();
    }
  }

  /** Whether the rolling tail has overflowed either configured limit. */
  isTruncated(): boolean {
    return this.totalDecodedBytes > this.limits.maxBytes || this.completedLines + (this.hasOpenLine ? 1 : 0) > this.limits.maxLines;
  }

  /** Build a bounded snapshot suitable for streaming partial updates. */
  snapshot(options: { persistIfTruncated?: boolean } = {}): BashOutputSnapshot {
    const snapshotText = this.tailStartsAtLineBoundary
      ? this.tailText
      : (() => {
          const firstNewline = this.tailText.indexOf("\n");
          return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
        })();
    const content = truncateTailWithinLimits(snapshotText, this.limits);
    const totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
    const truncatedBy: "bytes" | "lines" | null = this.isTruncated()
      ? this.totalDecodedBytes > this.limits.maxBytes
        ? "bytes"
        : "lines"
      : null;

    if (options.persistIfTruncated && truncatedBy) {
      this.ensureTempFile();
    }

    return {
      content,
      truncated: Boolean(truncatedBy),
      truncatedBy,
      totalBytes: this.totalDecodedBytes,
      totalLines,
      ...(this.tempFilePath ? { fullOutputPath: this.tempFilePath } : {}),
    };
  }

  /** Drain and close the persisted full-output file, if one was opened. */
  async closeTempFile(): Promise<void> {
    const stream = this.tempFileStream;
    if (!stream) return;
    this.tempFileStream = undefined;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        stream.off("finish", onFinish);
        reject(error);
      };
      const onFinish = () => {
        stream.off("error", onError);
        resolve();
      };
      stream.once("error", onError);
      stream.once("finish", onFinish);
      stream.end();
    });
  }

  /** Bytes consumed by the in-progress (un-terminated) last line. */
  getLastLineBytes(): number {
    return this.currentLineBytes;
  }

  /** True when {@link finish} has already been called. */
  isFinished(): boolean {
    return this.finished;
  }

  private appendDecodedText(text: string): void {
    if (text.length === 0) return;
    const bytes = byteLength(text);
    this.totalDecodedBytes += bytes;
    this.tailText += text;
    this.tailBytes += bytes;
    if (this.tailBytes > this.limits.maxBytes * 2) {
      this.trimTail();
    }

    let lastNewline = -1;
    let newlines = 0;
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
      newlines++;
      lastNewline = i;
    }
    if (newlines === 0) {
      this.currentLineBytes += bytes;
      this.hasOpenLine = true;
    } else {
      this.completedLines += newlines;
      const tail = text.slice(lastNewline + 1);
      this.currentLineBytes = byteLength(tail);
      this.hasOpenLine = tail.length > 0;
    }
  }

  private trimTail(): void {
    const buffer = Buffer.from(this.tailText, "utf-8");
    if (buffer.length <= this.limits.maxBytes) {
      this.tailBytes = buffer.length;
      return;
    }
    let start = buffer.length - this.limits.maxBytes;
    while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
    this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
    this.tailText = buffer.subarray(start).toString("utf-8");
    this.tailBytes = byteLength(this.tailText);
  }

  private shouldUseTempFile(): boolean {
    return (
      this.totalRawBytes > this.limits.maxBytes ||
      this.totalDecodedBytes > this.limits.maxBytes ||
      this.completedLines + (this.hasOpenLine ? 1 : 0) > this.limits.maxLines
    );
  }

  private ensureTempFile(): void {
    if (this.tempFilePath) return;
    this.tempFilePath = this.explicitTempFilePath ?? defaultTempFilePath(this.tempFilePrefix);
    this.tempFileStream = createWriteStream(this.tempFilePath);
    for (const chunk of this.rawChunks) {
      this.tempFileStream.write(chunk);
    }
    this.rawChunks = [];
  }
}

/**
 * Optional callback used by {@link runBashWithPartialUpdates} to stream
 * bounded partial snapshots to the model layer or TUI while the underlying
 * command is still producing output. Callers that omit the callback get the
 * usual fully-buffered behavior.
 */
export type BashPartialUpdateCallback = (snapshot: BashOutputSnapshot) => void;

/**
 * Hook a {@link BashOutputAccumulator} around an already-spawned child
 * process. Each non-empty `data` chunk is appended and the latest bounded
 * snapshot is forwarded to `onPartialUpdate` whenever new output arrived.
 *
 * The helper is intentionally small: it only knows how to mirror
 * `ChildProcess` stdout/stderr into the accumulator; command execution,
 * timeout enforcement, and final-result formatting remain the caller's job so
 * we don't bypass the existing foreground spill logic in
 * `global/bash`.
 */
export interface AttachBashStreamOptions {
  onPartialUpdate?: BashPartialUpdateCallback;
  /** Minimum interval between partial snapshots (ms). Defaults to no throttling. */
  throttleMs?: number;
}

export function attachBashStream(
  child: { stdout: NodeJS.ReadableStream | null; stderr: NodeJS.ReadableStream | null },
  accumulator: BashOutputAccumulator,
  options: AttachBashStreamOptions = {},
): void {
  let pending = false;
  let lastEmit = 0;
  const flush = () => {
    pending = false;
    if (!options.onPartialUpdate) return;
    const now = Date.now();
    if (options.throttleMs !== undefined && now - lastEmit < options.throttleMs) {
      pending = true;
      return;
    }
    lastEmit = now;
    options.onPartialUpdate(accumulator.snapshot({ persistIfTruncated: true }));
  };
  const onChunk = (chunk: Buffer | string) => {
    accumulator.append(chunk);
    if (options.onPartialUpdate) flush();
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
}
