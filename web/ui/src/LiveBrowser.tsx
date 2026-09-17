/**
 * The live browser pane: the thread's own Chromium, as Steel renders it.
 *
 * ## Why this is an iframe and not our own canvas
 *
 * Steel ships a complete viewer, and it is the renderer. It draws the page,
 * renders frames to a canvas, and sends mouse and key events back into the same
 * Chromium the agent drives. Reimplementing that here would be a worse copy of
 * it, kept in step with Steel's cast protocol by hand. So the pane embeds that
 * viewer, served from `/api/live-view` on this gateway rather than from Steel
 * directly, because the gateway scopes it to this thread's page and puts it on
 * the UI's own origin.
 *
 * ## The two locks
 *
 * Steel's viewer is left interactive permanently, and input is blocked on this
 * side by a transparent overlay rather than by toggling `interactive` on the
 * iframe. Toggling it means changing the iframe's `src`, which reloads the
 * viewer and drops the stream: the pane would flicker and reconnect on every
 * takeover. An overlay changes nothing about the stream.
 *
 * Blocking input here is only half of it, and the weaker half. The real lock is
 * the lease on the server: while the human owns the browser, the agent's
 * `browser_use` calls are refused outright. The overlay stops an accidental
 * click; the lease stops the agent and the human from both driving at once,
 * which is the failure that actually corrupts a task.
 *
 * ## Why the iframe never remounts
 *
 * `viewerUrl` depends on the thread and a manual reload counter, and on nothing
 * else. If it also depended on the control state, every takeover would recreate
 * the `src`, reconnect the socket and lose the frames, so the pane would go
 * dark at the exact moment the user is about to interact with it.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import type { BrowserSurface } from "@reaper/web-shared";

/** What the server says about who owns input. */
type Owner = "agent" | "human";

/**
 * The pane's own state machine, which is the server's plus the two transient
 * phases where the UI must not accept input even though the lease has not
 * changed yet.
 */
type PaneState = "agent" | "pausing" | "human" | "resync";

export function LiveBrowser({ baseUrl, threadId, surface }: {
  baseUrl: string;
  threadId: string | undefined;
  surface: BrowserSurface | undefined;
}) {
  const [state, setState] = useState<PaneState>("agent");
  const [error, setError] = useState<string | undefined>(undefined);
  /*
   * The viewer is keyed by a nonce so "Reload" genuinely re-mounts it. Steel's
   * viewer holds a socket and a canvas, and asking it to reconnect internally
   * is not something this side can do: a fresh `src` is the honest way to get a
   * fresh stream.
   */
  const [nonce, setNonce] = useState(0);

  const root = baseUrl.replace(/\/$/, "");

  const viewerUrl = useMemo(() => {
    if (!threadId) return undefined;
    const url = new URL("/api/live-view", new URL(baseUrl, window.location.href));
    url.searchParams.set("threadId", threadId);
    url.searchParams.set("r", String(nonce));
    return url.toString();
  }, [baseUrl, threadId, nonce]);

  /*
   * The lease lives on the server, so it is read on mount rather than assumed.
   * A pane opened while the human already has control must show that, not reset
   * to agent, which would show "Take control" for a browser they already own
   * and hide that the agent is paused.
   */
  useEffect(() => {
    if (!threadId) return;
    let cancelled = false;
    void fetch(`${root}/api/browser-control?threadId=${encodeURIComponent(threadId)}`)
      .then((response) => (response.ok ? response.json() : undefined))
      .then((body: { owner?: Owner } | undefined) => {
        if (!cancelled && body?.owner) setState(body.owner);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [root, threadId]);

  /*
   * Bring the stream back when the server it was talking to comes back.
   *
   * The viewer is an iframe holding a socket to this gateway. When the gateway
   * restarts, that socket dies and nothing re-establishes it: the iframe keeps
   * its dead connection and the pane sits on "Session connecting" forever, even
   * though the browser it is meant to show was never touched. Measured during
   * the ten-site mission, where a deliberate restart left the pane showing zero
   * tabs while the agent's pages were all still open.
   *
   * So health is watched, and a recovery bumps the nonce, which is the mechanism
   * this component already has for giving the viewer a fresh source. Only the
   * transition from unhealthy to healthy remounts: polling alone would reload
   * the stream every few seconds and flicker.
   */
  useEffect(() => {
    let wasDown = false;
    let cancelled = false;
    const timer = setInterval(() => {
      void fetch(`${root}/healthz`, { cache: "no-store" })
        .then((response) => {
          if (cancelled) return;
          if (!response.ok) { wasDown = true; return; }
          if (wasDown) { wasDown = false; setNonce((n) => n + 1); }
        })
        .catch(() => { wasDown = true; });
    }, 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [root]);

  const changeControl = useCallback(async (action: "take" | "return") => {
    if (!threadId) return;
    /*
     * The overlay goes up *before* the request, in both directions. Taking
     * control waits for the server to confirm the agent is paused, so input is
     * blocked until it answers; returning control blocks immediately, because
     * the user has said they are done and a click landing during the resync
     * would land on a page the agent is already re-reading.
     */
    setState(action === "take" ? "pausing" : "resync");
    setError(undefined);
    try {
      const response = await fetch(`${root}/api/browser-control?threadId=${encodeURIComponent(threadId)}&action=${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const body = await response.json() as { owner?: Owner; detail?: string };
      if (!response.ok) {
        setError(body.detail ?? "the control change was refused");
        setState(action === "take" ? "agent" : "human");
        return;
      }
      setState(body.owner ?? (action === "take" ? "human" : "agent"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "the control change failed");
      setState(action === "take" ? "agent" : "human");
    }
  }, [root, threadId]);

  const human = state === "human";
  /*
   * Input is blocked whenever the human does not *currently* own the browser,
   * which includes both transitions. That is the whole rule, and it is stated
   * as "not human" rather than as a list of blocked states so a new state added
   * later defaults to safe.
   */
  const blocked = !human;

  return (
    <div className="browser">
      <div className="browser-bar">
        <span className="browser-owner" data-owner={human ? "human" : "agent"}>
          {state === "pausing" ? "Pausing Reaper…"
            : state === "resync" ? "Reaper is re-reading the page…"
            : human ? "You have control" : "Reaper is controlling"}
        </span>
        <span className="browser-spacer" />
        <button className="button" data-variant="ghost" onClick={() => setNonce((value) => value + 1)}>Reload</button>
        <button
          className="button"
          data-variant={human ? "ghost" : "primary"}
          disabled={state === "pausing" || state === "resync" || !threadId}
          onClick={() => void changeControl(human ? "return" : "take")}
        >
          {human ? "Return to Reaper" : "Take control"}
        </button>
      </div>

      {error ? <p className="browser-note" data-tone="warn">{error}</p> : null}

      {viewerUrl ? (
        <div className="browser-stage" data-human={human}>
          {/*
           * The blocker sits inside a wrapper rather than directly in the
           * scrolling stage.
           *
           * `position: absolute` on the blocker resolves against the nearest
           * positioned ancestor, and the stage is one. With the stage scrolling,
           * an absolutely positioned blocker would be placed against the
           * stage's *scroll box* and would slide up out of the visible area as
           * the user scrolled, leaving the top of the page clickable while the
           * agent is driving. The wrapper is that ancestor now, so the blocker
           * covers the frame wherever the stage has been scrolled to.
           */}
          <div className="browser-fit">
            {/*
             * `clipboard-read; clipboard-write` because the reason a human takes
             * over is often to paste something: a one-time code, a password from
             * a manager, a card number. Without the permission the paste silently
             * does nothing.
             */}
            <iframe
              className="browser-frame"
              src={viewerUrl}
              title="Live browser"
              allow="clipboard-read; clipboard-write"
            />
            {/*
             * The input blocker. Only present when the human does not own the
             * browser, and it is what stops a stray click from reaching Steel
             * while the agent is driving. It covers the whole frame, so the page
             * inside stays visible and scrollable-looking while being inert.
             */}
            {blocked ? <div className="browser-blocker" aria-hidden="true" /> : null}
          </div>
        </div>
      ) : (
        <p className="browser-note">
          {surface
            ? "The agent's page is not streaming yet; it appears as soon as the page is live."
            : "The agent has not used the browser yet. The page appears here when it does."}
        </p>
      )}
    </div>
  );
}
