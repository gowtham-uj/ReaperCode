/**
 * A transcript built from fixtures, for looking at.
 *
 * The transcript is the one part of this app whose correctness is visual, and
 * the only way to check it has been to drive a live model and screenshot what
 * came back. That costs a provider round trip per iteration and produces a
 * different transcript every time, so two screenshots taken ten minutes apart
 * are not comparable and a spacing change cannot be isolated from a different
 * model answer.
 *
 * This renders the real components against a fixed set of items instead. Same
 * `Transcript`, same CSS, deterministic content: a running step, a failed
 * command, a diff, a search with many matches. It is mounted only when the dev
 * server is running, so it adds nothing to a production bundle.
 */

import { Transcript } from "../Transcript.js";
import type { AppTurn } from "@reaper/web-shared";

const DIFF = `@@ -100,7 +100,8 @@ export async function refresh(session: Session) {
       // Persist the new refresh token before retrying the request
       if (newTokens?.refreshToken) {
-        // was only updating in memory
+        await storage.setItem("refresh_token", newTokens.refreshToken);
         session.refreshToken = newTokens.refreshToken;
+        await persistSession(session);
       }`;

/*
 * A headerless diff, which is what `edit_file` and an unanchored `file_edit`
 * actually produce.
 *
 * The difference matters on screen and is not visible in the fixture above: a
 * bare `@@` means the call carried no line number, so the rows must render with
 * no gutter at all rather than counting from 1. A gallery that only ever drew
 * the hand-written header case would show the gutter working on every card and
 * never catch a regression that numbered a position nobody stated.
 */
const HEADERLESS_DIFF = `@@
-const TIMEOUT_MS = 30_000;
+const TIMEOUT_MS = 45_000;
 let attempt = 0;
-while (attempt < 3) {
+while (attempt < 5) {`;

/*
 * A diff the server capped, with the counts it sent alongside.
 *
 * The counts are the whole point: they are larger than the kept text, so a
 * client that recounted the `+` lines it can see would print a smaller change
 * than happened. Rendering this fixture is how that stays fixed.
 */
const TRUNCATED_DIFF = `@@
+generated line 1
+generated line 2
+generated line 3
@@ truncated: 1,448 lines changed in total @@`;

const TURNS: AppTurn[] = [
  {
    id: "turn-1",
    status: "completed",
    items: [
      {
        type: "userMessage",
        id: "u1",
        content: [{ type: "text", text: "Find why authentication state is lost after context compaction and fix it." }],
      },
    ],
  },
  {
    id: "turn-2",
    status: "inProgress",
    items: [
      {
        type: "agentMessage",
        id: "a1",
        phase: "commentary",
        text: "I'm tracing where authentication state gets lost. I'll search for the refresh token flow, follow the session persistence logic, and identify what breaks after context compaction.",
      },
      {
        type: "dynamicToolCall",
        id: "t1",
        tool: "grep_search",
        arguments: { pattern: "refreshToken", path: "src/" },
        status: "completed",
        durationMs: 320,
        result: "src/auth/session.ts:84\nsrc/auth/session.ts:112\nsrc/store/session.ts:19\nsrc/store/session.ts:44\nsrc/auth/token.ts:51\nsrc/auth/token.ts:77\nsrc/api/client.ts:203\ntests/auth/session.test.ts:12",
      },
      {
        type: "dynamicToolCall",
        id: "t2",
        tool: "file_view",
        arguments: { path: "src/auth/session.ts", start: 84, end: 167 },
        status: "completed",
        durationMs: 180,
        result: "export async function refresh(session: Session) {\n  const newTokens = await requestTokens(session);\n  if (newTokens?.refreshToken) {\n    session.refreshToken = newTokens.refreshToken;\n  }\n  return session;\n}",
      },
      {
        type: "dynamicToolCall",
        id: "t3",
        tool: "file_view",
        arguments: { path: "src/store/session.ts", start: 1, end: 120 },
        status: "completed",
        durationMs: 210,
        result: "export async function persistSession(session: Session) {\n  await storage.setItem(\"session\", JSON.stringify(session));\n}",
      },
      {
        type: "dynamicToolCall",
        id: "t4",
        tool: "grep_search",
        arguments: { pattern: "persistSession", path: "src/" },
        status: "completed",
        durationMs: 160,
        result: "src/store/session.ts:8\nsrc/auth/session.ts:132\nsrc/api/client.ts:88\ntests/auth/session.test.ts:40",
      },
      {
        type: "dynamicToolCall",
        id: "t5",
        tool: "file_view",
        arguments: { path: "src/auth/token.ts", start: 42, end: 90 },
        status: "inProgress",
      },
    ],
  },
  {
    id: "turn-3",
    status: "completed",
    items: [
      {
        type: "fileChange",
        id: "f1",
        status: "completed",
        durationMs: 640,
        changes: [{ path: "src/auth/session.ts", kind: "edit_file", diff: DIFF, additions: 2, removals: 1 }],
      },
      {
        /*
         * The two shapes a real transcript produces most often, side by side
         * with the hand-written one above: an edit whose tool knew no line
         * number, and a write the server capped. Neither appears in the fixtures
         * before this, so neither was ever looked at.
         */
        type: "fileChange",
        id: "f2",
        status: "completed",
        durationMs: 180,
        changes: [{ path: "src/net/retry.ts", kind: "edit_file", diff: HEADERLESS_DIFF, additions: 2, removals: 2 }],
      },
      {
        type: "fileChange",
        id: "f3",
        status: "completed",
        durationMs: 2_400,
        changes: [{
          path: "src/generated/schema.ts",
          kind: "write_file",
          diff: TRUNCATED_DIFF,
          additions: 1_448,
          removals: 0,
          truncated: true,
        }],
      },
      {
        type: "commandExecution",
        id: "c1",
        command: "npm test -- auth",
        status: "completed",
        exitCode: 0,
        durationMs: 12_400,
        aggregatedOutput: "> reaper@0.1.47 test\n> node scripts/run-node-tests.mjs auth\n\n  auth/session\n    ✓ persists the refreshed token\n    ✓ survives a compaction boundary\n\n  18 passing (2.3s)\n  0 failing",
      },
      {
        type: "commandExecution",
        id: "c2",
        command: "npm run lint -- --max-warnings 0 src/auth",
        status: "failed",
        exitCode: 1,
        durationMs: 2_100,
        aggregatedOutput: "src/auth/session.ts\n  104:9  warning  Unexpected console statement  no-console\n\n✖ 1 problem (0 errors, 1 warning)",
      },
      {
        type: "agentMessage",
        id: "a2",
        phase: "final_answer",
        text: "The refresh token was updated in memory but not persisted before retry. I fixed the persistence path and added a regression test.\n\n- `src/auth/session.ts` now writes the token through `storage.setItem` before the retry\n- `persistSession` is awaited so a compaction boundary cannot land between the two writes\n\nTests are passing. The lint warning is a stray `console.log` I left in while tracing; say the word and I'll remove it.",
      },
    ],
  },
];

/**
 * The cases that break a transcript, which the tidy fixture above never hits.
 *
 * A 1,482-line build log, a rename that produced a 900-line diff, and fifty
 * reads in a row. Each of these has its own way of making the page unusable,
 * and none of them is visible in a fixture built out of well-behaved calls.
 * Reachable at `/__gallery?stress`.
 */
const BIG_LOG = Array.from({ length: 1482 }, (_, index) =>
  index === 1300 ? "ERROR  Cannot find module './session-store'" : `  transforming (${index + 1}) src/module-${index}.ts`).join("\n");

const BIG_DIFF = [
  "@@ -1,40 +1,40 @@ renamed across the module",
  ...Array.from({ length: 900 }, (_, index) =>
    index % 2 === 0 ? `-  const oldName${index} = resolve(index);` : `+  const newName${index} = resolve(index);`),
].join("\n");

const STRESS: AppTurn[] = [
  {
    id: "s-1",
    status: "completed",
    items: [{ type: "userMessage", id: "su", content: [{ type: "text", text: "Rename the session store and make the build pass." }] }],
  },
  {
    id: "s-2",
    status: "completed",
    items: [
      { type: "agentMessage", id: "sa", phase: "commentary", text: "Renaming the module, then rebuilding to see what broke." },
      { type: "fileChange", id: "sf", status: "completed", changes: [{ path: "src/store/session.ts", kind: "edit", diff: BIG_DIFF }] },
      { type: "commandExecution", id: "sc", command: "npm run build", status: "failed", exitCode: 1, durationMs: 48_200, aggregatedOutput: BIG_LOG },
    ],
  },
  {
    id: "s-3",
    status: "inProgress",
    items: [
      { type: "agentMessage", id: "sa2", phase: "commentary", text: "Checking every importer of the old path." },
      ...Array.from({ length: 50 }, (_, index) => ({
        type: "dynamicToolCall" as const,
        id: `sr-${index}`,
        tool: "file_view",
        arguments: { path: `src/feature/module-${index}/index.ts` },
        status: "completed" as const,
        durationMs: 40 + index,
        result: "import { sessionStore } from \"../../store/session.js\";",
      })),
      { type: "dynamicToolCall", id: "sr-last", tool: "grep_search", arguments: { pattern: "session-store", path: "src/" }, status: "inProgress" },
    ],
  },
];

export function TranscriptGallery() {
  const stress = window.location.search.includes("stress");
  /*
   * Wrapped in `.conversation-root`, because that is where the chat column's
   * width clamp lives. Without it the fixtures render full-bleed and every
   * judgement about line length and density is made at a width the app never
   * uses.
   */
  return (
    <div className="conversation-root">
      <div className="conversation-scroll">
        <div className="chat-column">
          {stress
            ? <Transcript turns={STRESS} activeTurnId="s-3" />
            : <Transcript turns={TURNS} activeTurnId="turn-2" />}
        </div>
      </div>
    </div>
  );
}
