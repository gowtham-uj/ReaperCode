import { describe, expect, it } from "vitest";

import { threadAgeLabel, threadLabel, threadWorkspaceLabel } from "./ThreadList.js";

const NOW = Date.parse("2026-08-30T12:00:00.000Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

describe("threadAgeLabel", () => {
  it("buckets by the boundary, not the midpoint", () => {
    expect(threadAgeLabel(ago(59_999), NOW)).toBe("Just now");
    expect(threadAgeLabel(ago(60_000), NOW)).toBe("1m ago");
    expect(threadAgeLabel(ago(59 * 60_000), NOW)).toBe("59m ago");
    expect(threadAgeLabel(ago(60 * 60_000), NOW)).toBe("1h ago");
    expect(threadAgeLabel(ago(23 * 3_600_000), NOW)).toBe("23h ago");
    expect(threadAgeLabel(ago(24 * 3_600_000), NOW)).toBe("1d ago");
    expect(threadAgeLabel(ago(6 * 86_400_000), NOW)).toBe("6d ago");
  });

  it("falls back to a date once a week has passed", () => {
    expect(threadAgeLabel(ago(7 * 86_400_000), NOW)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });

  it("returns nothing rather than a wrong label for unusable input", () => {
    // A malformed stamp must not render as "Just now" — that would read as a
    // fresh thread rather than an unreadable one.
    expect(threadAgeLabel(undefined, NOW)).toBeUndefined();
    expect(threadAgeLabel("", NOW)).toBeUndefined();
    expect(threadAgeLabel("not a date", NOW)).toBeUndefined();
  });

  it("does not render a future timestamp as an age", () => {
    // Clock skew between the app-server and the browser is real; a negative
    // elapsed value fell through to "Just now", which is the least confusing
    // reading, but assert it so the behaviour is deliberate.
    expect(threadAgeLabel(ago(-5 * 60_000), NOW)).toBe("Just now");
  });
});

describe("thread row labelling", () => {
  it("never labels a thread with its machine id", () => {
    expect(threadLabel({ id: "807fc1cb-1dc7-40c8-a7b9-334e7370d3ac" })).toBe("Untitled thread");
  });

  it("hides the thread-scoped workspace path but keeps a real project", () => {
    // The default workspace is derived from the thread UUID, so printing it
    // would leak an internal id onto every row and repeat the same string.
    expect(threadWorkspaceLabel("/home/dev/.reaper/workspaces/807fc1cb-1dc7-40c8-a7b9-334e7370d3ac")).toBeUndefined();
    expect(threadWorkspaceLabel("/work/reaper-code")).toBe("work/reaper-code");
    expect(threadWorkspaceLabel(undefined)).toBeUndefined();
  });
});
