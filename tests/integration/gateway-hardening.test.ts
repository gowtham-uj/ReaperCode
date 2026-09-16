/**
 * The REST surface refuses what the WebSocket already refused.
 *
 * The Origin guard was enforced on `/ws` only, which made it look complete. The
 * REST surface never inspected Origin at all, so a page on a foreign origin
 * could POST to `/api/upload` while being refused the socket beside it:
 * verified, and the bytes landed on disk in the server's own workspace root.
 * Refusing a request on one listener and accepting the same request on the
 * other is not a boundary, so both now call one rule.
 *
 * The two file checks are here for the same reason: they are paths a *sandboxed*
 * process can set up and the *host* then follows. The sandbox stops the program
 * reading an unmounted path; the gateway runs on the host and only checked the
 * string, so a link the sandbox created was resolved by the host, and a write
 * through it landed outside the root while the response reported a path that
 * read as though it were inside.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startAppServer } from "../../src/app-server/server.js";
import { originAllowed } from "../../src/app-server/web/gateway.js";
import { parsePreviewPath } from "../../src/app-server/web/preview.js";
import { createTempWorkspace } from "../fixtures/workspace.js";
import WebSocket from "ws";

/** A gateway socket speaking the RPC shape the UI uses. */
function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers: { Origin: "http://127.0.0.1:5273" } });
    socket.on("open", () => resolve(socket));
  });
}

/** One JSON-RPC call, resolved by id. */
function rpc(socket: WebSocket, id: number, method: string, params: unknown): Promise<{ result?: any; error?: { code: number; message: string } }> {
  return new Promise((resolve) => {
    const onMessage = (data: unknown): void => {
      const parsed = JSON.parse(String(data));
      if (parsed.id === id) {
        socket.off("message", onMessage);
        resolve(parsed);
      }
    };
    socket.on("message", onMessage);
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    setTimeout(() => resolve({ error: { code: -1, message: "timeout" } }), 10_000);
  });
}


test("the origin rule allows the UI and refuses a page the server did not serve", () => {
  // A non-browser client has no Origin, and is already inside the loopback
  // boundary this surface trusts.
  assert.equal(originAllowed(undefined, "127.0.0.1:4180"), true);
  // The dev setup proxies from Vite on one loopback port to the gateway on
  // another, so those two do not share a Host and loopback has to be allowed.
  assert.equal(originAllowed("http://127.0.0.1:5273", "127.0.0.1:4180"), true);
  // Same-origin against the request's own Host, which is what a published
  // deployment looks like.
  assert.equal(originAllowed("https://167.86.121.124:5273", "167.86.121.124:5273"), true);
  // Anything else is a page this server did not serve.
  assert.equal(originAllowed("http://evil.example.com", "127.0.0.1:4180"), false);
  assert.equal(originAllowed("not a url", "127.0.0.1:4180"), false);
});

test("the REST surface refuses a foreign origin, including the upload write", async () => {
  const workspaceRoot = await createTempWorkspace();
  const server = await startAppServer({ workspaceRoot, listen: "ws://127.0.0.1:0", web: { host: "127.0.0.1", port: 0 } });
  const base = server.web!.url;
  try {
    const foreign = await fetch(`${base}/api/files?path=.`, { headers: { Origin: "http://evil.example.com" } });
    assert.equal(foreign.status, 403, "a foreign origin must not read the file tree");

    const upload = await fetch(`${base}/api/upload?path=csrf-probe`, {
      method: "POST",
      headers: { Origin: "http://evil.example.com" },
      body: "WRITTEN",
    });
    assert.equal(upload.status, 403, "and must not write");
    assert.equal(existsSync(join(workspaceRoot, "csrf-probe")), false, "the write must not have happened");

    // The same server, reached the way the UI reaches it.
    const allowed = await fetch(`${base}/api/files?path=.`, { headers: { Origin: "http://127.0.0.1:5273" } });
    assert.equal(allowed.status, 200, "the UI's own origin must still work");
  } finally {
    await server.stop();
    await rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("a symlink out of the root is not followed, and a write through one creates nothing", async () => {
  const workspaceRoot = await createTempWorkspace();
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  writeFileSync(join(outside, "secret.txt"), "HOST-ONLY");
  try {
    const server = await startAppServer({ workspaceRoot, listen: "ws://127.0.0.1:0", web: { host: "127.0.0.1", port: 0 } });
    const base = server.web!.url;
    try {
      symlinkSync(join(outside, "secret.txt"), join(workspaceRoot, "link.txt"));
      symlinkSync(outside, join(workspaceRoot, "linkdir"));

      const viaFile = await fetch(`${base}/api/file?path=link.txt`);
      assert.equal(viaFile.status, 403, "a file symlink must not be followed out of the root");

      const viaDir = await fetch(`${base}/api/file?path=linkdir/secret.txt`);
      assert.equal(viaDir.status, 403, "nor a directory symlink");

      const write = await fetch(`${base}/api/upload?path=linkdir/deep/evil.txt`, { method: "POST", body: "X" });
      assert.equal(write.status, 403, "a write through a directory symlink must be refused");
      /*
       * The directory must not have been created either. `mkdir(recursive)`
       * used to run before the check, so a refused upload still left `deep/`
       * outside the root, which is a side effect the refusal did not undo.
       */
      assert.equal(existsSync(join(outside, "deep")), false, "the refused write must not create directories");

      // A NUL byte is a wrong error class, not a traversal, and it is refused.
      const nul = await fetch(`${base}/api/file?path=${encodeURIComponent("..\0/etc/passwd")}`);
      assert.equal(nul.status, 403);
    } finally {
      await server.stop();
    }
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

/*
 * The preview proxy reaches dev servers, and nothing else.
 *
 * It was a general loopback proxy: the port check bounded how many ports it
 * reached, and every service worth reaching sits above 1024. Verified before:
 * `/preview/9222/json/version` returned the shared Chrome's CDP descriptor and
 * `/preview/4180/healthz` returned the gateway's own, so anything able to fetch
 * from this server could also drive the browser every thread shares.
 */
test("the preview proxy refuses the browser's CDP port and the gateway's own", () => {
  assert.equal(parsePreviewPath("/preview/9222/json/version"), undefined, "CDP must not be reachable");
  assert.equal(parsePreviewPath("/preview/4180/healthz"), undefined, "nor the gateway itself");
  // Below 1024 is a system service, which was already refused.
  assert.equal(parsePreviewPath("/preview/80/"), undefined);
  // A dev server the agent started is what this exists for.
  assert.deepEqual(parsePreviewPath("/preview/3000/app?x=1"), { port: 3000, path: "/app?x=1" });
});

/*
 * A tab may not change a thread it was never attached to.
 *
 * The gateway registered interest in any thread a tab named, which is right for
 * reading and wrong for changing one. Verified: a tab that had never created
 * thread X sent one `thread/workspace/set` and X's `cwd` became `/root`, after
 * which the root itself served that directory to every tab. The same hole let
 * any page rename another conversation, change its model, or close it.
 *
 * `thread/start` and `thread/resume` are exempt because they are how a tab
 * becomes attached; requiring prior attachment would make them impossible.
 */
test("a mutating call on an unattached thread is refused", async () => {
  const workspaceRoot = await createTempWorkspace();
  const server = await startAppServer({ workspaceRoot, listen: "ws://127.0.0.1:0", web: { host: "127.0.0.1", port: 0 } });
  const base = server.web!.url;
  const wsUrl = `ws${base.slice("http".length)}/ws`;
  try {
    const a = await openSocket(wsUrl);
    try {
      const started = await rpc(a, 1, "thread/start", { cwd: workspaceRoot });
      const threadId = started?.result?.thread?.id ?? started?.result?.id;
      assert.ok(threadId, `thread/start must return an id, got ${JSON.stringify(started).slice(0, 160)}`);

      // A second tab, which has done nothing with this thread.
      const b = await openSocket(wsUrl);
      try {
        const hijack = await rpc(b, 2, "thread/workspace/set", { threadId, workspaceRoot: "/root" });
        assert.ok(hijack.error, "an unattached tab must not re-root a thread");
        assert.equal(hijack.error.code, -32600);

        assert.ok((await rpc(b, 3, "thread/name/set", { threadId, name: "pwned" })).error, "nor rename it");
        assert.ok((await rpc(b, 4, "thread/close", { threadId })).error, "nor close it");

        /*
         * Reading is still open, and resuming is how attachment happens. The
         * pair is the point: the check must gate changing, not reaching.
         */
        assert.ok(!(await rpc(b, 5, "thread/read", { threadId })).error, "reading another thread's state stays allowed");
        assert.ok(!(await rpc(b, 6, "thread/resume", { threadId, subscribe: false })).error, "resume is how a tab attaches");

        // And once attached, the same call is allowed.
        const after = await rpc(b, 7, "thread/workspace/set", { threadId, workspaceRoot: join(workspaceRoot, "moved") });
        assert.ok(!after.error, "an attached tab must be able to reconfigure its thread");
      } finally {
        b.close();
      }
    } finally {
      a.close();
    }
  } finally {
    await server.stop();
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
