/**
 * The wedged-page sweep.
 *
 * The behaviour under test is the one that took out three mission runs: a single
 * target whose renderer stops answering makes Playwright's `connectOverCDP` hang
 * forever, and the sweep has to find that target and close it without a
 * Playwright connection, because Playwright is the thing that is stuck.
 *
 * A real websocket server stands in for Steel, so the test exercises the actual
 * socket path rather than a mock of it: the sweep's whole justification is that
 * it works at the layer below Playwright, and a mocked transport would not test
 * that claim at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer, WebSocket } from "ws";

import { closeTargets, connectWithRecovery, findUnresponsiveTargets, resetUnresponsiveTargets } from "../../../src/browser/cdp-health.js";

interface FakeTarget {
  targetId: string;
  type: string;
  url: string;
  /** When true, the target attaches but never answers Runtime.evaluate. */
  wedged?: boolean;
  /**
   * How many opening Runtime.evaluate calls to ignore before answering.
   *
   * Models the transient overload that a burst of parallel probes causes: the
   * renderer is fine and answers as soon as the burst has passed. A target that
   * eventually answers must never be reported as wedged.
   */
  slowFor?: number;
}

/**
 * A CDP endpoint that behaves like the measured failure.
 *
 * `Target.getTargets` answers immediately, `attachToTarget` answers immediately,
 * and a wedged target simply never replies to `Runtime.evaluate`. That shape is
 * what was measured against the live browser: the attach succeeded, the renderer
 * did not answer, and the client waited until it gave up.
 */
function startFakeSteel(targets: FakeTarget[]): Promise<{ url: string; closed: string[]; probed: number; stop: () => Promise<void> }> {
  const wss = new WebSocketServer({ port: 0 });
  const closed: string[] = [];
  // Counts liveness probes, so a test can assert the sweep was never reached.
  const counters = { probed: 0 };
  return new Promise((resolve) => {
    wss.on("listening", () => {
      const address = wss.address() as { port: number };
      resolve({
        url: `ws://127.0.0.1:${address.port}`,
        closed,
        get probed() { return counters.probed; },
        stop: () => new Promise<void>((done) => wss.close(() => done())),
      });
    });
    wss.on("connection", (socket: WebSocket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { id: number; method: string; params?: Record<string, unknown> };
        const reply = (result: unknown): void => { socket.send(JSON.stringify({ id: message.id, result })); };
        switch (message.method) {
          case "Target.getTargets":
            reply({ targetInfos: targets.map((t) => ({ targetId: t.targetId, type: t.type, url: t.url, attached: false })) });
            return;
          case "Target.attachToTarget": {
            const id = message.params?.["targetId"] as string;
            reply({ sessionId: `session-${id}` });
            return;
          }
          case "Runtime.evaluate": {
            counters.probed += 1;
            const sessionId = (message as unknown as { sessionId?: string }).sessionId ?? "";
            const id = sessionId.replace("session-", "");
            const target = targets.find((t) => t.targetId === id);
            // A wedged target is the one that never answers. Nothing to send.
            if (target?.wedged === true) return;
            // A slow target ignores its first few probes, then answers. This is
            // the false positive the retry pass exists to absorb.
            if (target?.slowFor !== undefined && target.slowFor > 0) {
              target.slowFor -= 1;
              return;
            }
            reply({ result: { type: "number", value: 2 } });
            return;
          }
          case "Target.detachFromTarget":
            reply({});
            return;
          case "Target.closeTarget": {
            const id = message.params?.["targetId"] as string;
            closed.push(id);
            reply({ success: true });
            return;
          }
          default:
            reply({});
        }
      });
    });
  });
}

test("a target whose renderer never answers is found", async () => {
  const steel = await startFakeSteel([
    { targetId: "a", type: "page", url: "https://healthy.example/" },
    { targetId: "b", type: "page", url: "http://wedged.example/", wedged: true },
    { targetId: "c", type: "page", url: "https://healthy2.example/" },
  ]);
  try {
    const { hung, checked } = await findUnresponsiveTargets(steel.url, { probeTimeoutMs: 1_500 });
    assert.equal(checked, 3, "all three page targets are probed");
    assert.equal(hung.length, 1, "exactly the wedged target is reported");
    assert.equal(hung[0]!.targetId, "b");
    assert.equal(hung[0]!.url, "http://wedged.example/");
  } finally {
    await steel.stop();
  }
});

test("a page that is merely slow under load is never reported as wedged", async () => {
  // The regression this whole retry pass exists for. A burst of parallel probes
  // overloads Steel's single CDP proxy, and a healthy page can miss the first
  // probe. Such a page answers on a retry and must be left alone: an earlier
  // version of this sweep closed four healthy pages of a running mission this
  // way.
  const steel = await startFakeSteel([
    { targetId: "a", type: "page", url: "https://healthy.example/" },
    { targetId: "b", type: "page", url: "https://busy.example/", slowFor: 1 },
    { targetId: "c", type: "page", url: "https://busier.example/", slowFor: 2 },
  ]);
  try {
    const report = await resetUnresponsiveTargets(steel.url, { probeTimeoutMs: 1_500, attempts: 3, concurrency: 4 });
    assert.equal(report.hung.length, 0, "a page that answers on a retry is not wedged");
    assert.deepEqual(report.closed, [], "no healthy page was closed");
    assert.deepEqual(steel.closed, []);
  } finally {
    await steel.stop();
  }
});

test("a target that stays silent through every attempt is reported", async () => {
  const steel = await startFakeSteel([
    { targetId: "a", type: "page", url: "https://healthy.example/" },
    { targetId: "b", type: "page", url: "http://wedged.example/", wedged: true },
  ]);
  try {
    const { hung } = await findUnresponsiveTargets(steel.url, { probeTimeoutMs: 1_500, attempts: 3 });
    assert.deepEqual(hung.map((h) => h.targetId), ["b"]);
  } finally {
    await steel.stop();
  }
});

test("service workers and browser UI are left alone", async () => {
  // Only pages and iframes can be wedged in a way that hangs the handshake, and
  // closing a service worker unregisters a site's worker for the whole profile.
  const steel = await startFakeSteel([
    { targetId: "sw", type: "service_worker", url: "https://app.example/sw.js", wedged: true },
    { targetId: "ui", type: "browser_ui", url: "chrome://omnibox", wedged: true },
    { targetId: "p", type: "page", url: "https://ok.example/" },
  ]);
  try {
    const { hung, checked } = await findUnresponsiveTargets(steel.url, { probeTimeoutMs: 1_500 });
    assert.equal(checked, 1, "only the page target is a candidate");
    assert.equal(hung.length, 0, "a wedged service worker is not treated as a wedged page");
  } finally {
    await steel.stop();
  }
});

test("healthy targets are never closed", async () => {
  const steel = await startFakeSteel([
    { targetId: "a", type: "page", url: "https://one.example/" },
    { targetId: "b", type: "page", url: "https://two.example/" },
  ]);
  try {
    const report = await resetUnresponsiveTargets(steel.url, { probeTimeoutMs: 1_500 });
    assert.equal(report.hung.length, 0);
    assert.equal(report.closed.length, 0);
    assert.deepEqual(steel.closed, [], "nothing was closed on a healthy session");
  } finally {
    await steel.stop();
  }
});

test("the wedged page is closed and the healthy ones are not", async () => {
  const steel = await startFakeSteel([
    { targetId: "a", type: "page", url: "https://keep.example/" },
    { targetId: "b", type: "page", url: "http://wedged.example/", wedged: true },
  ]);
  try {
    const report = await resetUnresponsiveTargets(steel.url, { probeTimeoutMs: 1_500 });
    assert.deepEqual(report.closed.map((t) => t.targetId), ["b"]);
    assert.deepEqual(steel.closed, ["b"]);
  } finally {
    await steel.stop();
  }
});

test("an unreachable endpoint is skipped rather than thrown", async () => {
  // The sweep runs before a connect that is about to report the real failure.
  // Turning "Steel is down" into a diagnostic exception would replace a useful
  // error with a less useful one.
  const report = await resetUnresponsiveTargets("ws://127.0.0.1:1", { probeTimeoutMs: 200, budgetMs: 700 });
  assert.equal(report.closed.length, 0);
  assert.ok(report.skipped !== undefined, "the reason the sweep could not run is reported");
});

test("closing an empty list does nothing and opens nothing", async () => {
  const closed = await closeTargets("ws://127.0.0.1:1", []);
  assert.deepEqual(closed, []);
});

test("a successful connect never probes or closes anything", async () => {
  /*
   * The safety property of the recovery-first ordering, and the one the earlier
   * design got wrong: on a browser carrying eleven heavy tabs at load 16, a
   * preventive sweep reported a healthy page as silent and closed it while a
   * mission was using it. Here the sweep is only reached after a connect has
   * already failed, so a healthy browser cannot have a page closed.
   *
   * The connector is injected so the property is checked directly: a connect
   * that succeeds, and a sweep that would record being reached.
   */
  const steel = await startFakeSteel([{ targetId: "a", type: "page", url: "https://healthy.example/" }]);
  try {
    const browser = await connectWithRecovery(steel.url, {
      connect: async () => ({ ok: true }) as never,
    });
    assert.deepEqual(browser, { ok: true });
    assert.equal(steel.probed, 0, "a successful connect must not probe any target");
    assert.deepEqual(steel.closed, [], "and must not close any");
  } finally {
    await steel.stop();
  }
});

test("a failed connect sweeps and retries", async () => {
  // The mechanism itself: the first connect throws, the sweep finds the wedged
  // page, and the second connect succeeds. Without this the browser would stay
  // unattachable for every caller.
  const steel = await startFakeSteel([
    { targetId: "a", type: "page", url: "https://healthy.example/" },
    { targetId: "b", type: "page", url: "http://wedged.example/", wedged: true },
  ]);
  try {
    let calls = 0;
    const closed: string[] = [];
    const browser = await connectWithRecovery(steel.url, {
      connect: async () => {
        calls += 1;
        if (calls === 1) throw new Error("browserType.connectOverCDP: Timeout 45000ms exceeded.");
        return { ok: true } as never;
      },
      onClose: (report) => { for (const t of report.closed) closed.push(t.targetId); },
    });
    assert.equal(calls, 2, "the connect is retried once");
    assert.deepEqual(browser, { ok: true });
    assert.deepEqual(closed, ["b"], "the wedged page was closed and reported");
    assert.deepEqual(steel.closed, ["b"]);
  } finally {
    await steel.stop();
  }
});

test("a retry that is not helped by the sweep still throws", async () => {
  // The browser is not attachable for some other reason, so the caller must get
  // the real failure rather than a silent success or a diagnostic one.
  const steel = await startFakeSteel([{ targetId: "a", type: "page", url: "https://healthy.example/" }]);
  try {
    await assert.rejects(
      () => connectWithRecovery(steel.url, {
        connect: async () => { throw new Error("browserType.connectOverCDP: Timeout 45000ms exceeded."); },
      }),
      /Timeout 45000ms/,
    );
  } finally {
    await steel.stop();
  }
});

test("the runtime reports its capabilities without connecting", async () => {
  /*
   * A capability query must not be a thing that changes what the browser is
   * doing, so `isAttached()` answers from the handles rather than by attaching.
   * The mission spent thirteen calls working out whether downloads were possible
   * because there was no way to ask; this is the way to ask.
   */
  const { ThreadBrowserRuntime } = await import("../../../src/browser/thread-runtime.js");
  const runtime = new ThreadBrowserRuntime({
    threadId: "00000000-0000-0000-0000-000000000001",
    cdpUrl: "ws://127.0.0.1:1",
    // A short timeout so a test that accidentally connects fails fast.
    cdpTimeoutMs: 300,
  });

  assert.equal(runtime.isAttached(), false, "a runtime that has never attached reports not attached");
  assert.equal(runtime.downloadsAreEnabled, false, "and downloads are off until the command is accepted");
});
