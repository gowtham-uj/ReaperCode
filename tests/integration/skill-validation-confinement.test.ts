/**
 * A skill's validation command runs in the workspace, confined.
 *
 * Two defects met here, and the audit found both by running an ordinary skill:
 *
 * 1. The command ran with no working directory, so it inherited Reaper's own
 *    `process.cwd()` — the Reaper checkout. A validation line like
 *    `require("./showcase/stats.js")` failed with `MODULE_NOT_FOUND` against
 *    `/work`, and a probe running `pwd` printed `/work` while listing the whole
 *    Reaper install. The skill looked broken; the runner was.
 *
 * 2. The same command ran as a plain child of the Reaper process, so it could
 *    read the implementation directory, its `.env`, and its `node_modules`. A
 *    skill's validation line is documented as an ordinary shell command, and
 *    "ordinary shell command" cannot also mean "a way out of the workspace".
 *
 * The assertions are on observable outcomes — what directory the command sees,
 * what it can read — rather than on which function was called, because a test
 * of the calling convention would have passed the whole time both were live.
 *
 * Everything goes through `AuthoringDeps.build().handleSkillManager`, which is
 * what the executor hands to the `skill_manager` tool, so a wiring mistake in
 * the deps builder fails here rather than passing behind a hand-made lifecycle.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AuthoringRuntime } from "../../src/tools/write/authoring-deps.js";
import { resolveBubblewrap } from "../../src/policy/shell-sandbox.js";

const sandboxAvailable = resolveBubblewrap() !== undefined;

type SkillManagerResult = {
  ok?: boolean;
  results?: Array<{ stdout?: string; stderr?: string }>;
  error?: string;
  note?: string;
};

function managerFor(workspaceRoot: string, userHome: string): (args: never) => Promise<unknown> {
  return new AuthoringRuntime({ workspaceRoot, userHome }).build().handleSkillManager as (
    args: never,
  ) => Promise<unknown>;
}

/** Create a skill and run its validation, through the model-facing manager. */
async function createAndTest(
  handleSkillManager: (args: never) => Promise<unknown>,
  name: string,
  command: string,
): Promise<SkillManagerResult> {
  /*
   * The field names are the wire names the model sends, not the internal
   * camelCase: `when_to_use`, `allowed_tools`, `validation_commands`. The
   * internal spellings would be rejected by the strict schema, and a test that
   * quietly used them would not be exercising the model's path.
   */
  await handleSkillManager({
    action: "create",
    name,
    version: "0.1.0",
    description: name,
    category: "bug-fixing",
    when_to_use: "always",
    allowed_tools: ["file_view"],
    body: "# probe\n",
    validation_commands: [{ id: "probe", command }],
  } as never);
  return (await handleSkillManager({ action: "test", name } as never)) as SkillManagerResult;
}

function stdoutOf(result: SkillManagerResult): string {
  return result.results?.[0]?.stdout ?? "";
}

async function fixture(prefix: string): Promise<{ root: string; workspaceRoot: string; userHome: string }> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const workspaceRoot = path.join(root, "workspace");
  const userHome = path.join(root, "home");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(userHome, { recursive: true });
  return { root, workspaceRoot, userHome };
}

test("a skill validation command runs in the workspace, not Reaper's checkout", async () => {
  const { root, workspaceRoot, userHome } = await fixture("reaper-skill-cwd-");
  try {
    const manager = managerFor(workspaceRoot, userHome);
    const out = await createAndTest(manager, "cwd-probe", "pwd");

    assert.equal(out.ok, true, `validation failed: ${out.error ?? out.note ?? ""}`);
    /*
     * The workspace path itself is what is asserted. "Not /work" would pass for
     * any other wrong directory, which is not the property.
     */
    assert.ok(
      stdoutOf(out).includes(workspaceRoot),
      `validation must run in the workspace (${workspaceRoot}), got: ${JSON.stringify(stdoutOf(out).trim())}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the workspace is a real working directory, so an ordinary command succeeds", async () => {
  const { root, workspaceRoot, userHome } = await fixture("reaper-skill-ok-");
  try {
    await writeFile(path.join(workspaceRoot, "marker.txt"), "present\n", "utf8");
    const manager = managerFor(workspaceRoot, userHome);
    const out = await createAndTest(manager, "read-probe", "cat marker.txt");

    assert.equal(out.ok, true, `a legitimate validation must pass: ${out.error ?? out.note ?? ""}`);
    assert.match(stdoutOf(out), /present/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "a skill validation command cannot read Reaper's own checkout",
  { skip: !sandboxAvailable },
  async () => {
    const { root, workspaceRoot, userHome } = await fixture("reaper-skill-iso-");
    try {
      const manager = managerFor(workspaceRoot, userHome);
      /*
       * `grep -o` prints the match or nothing, and `|| true` keeps the exit code
       * at 0 either way, so the *content* is what is asserted. An earlier
       * version of this test catted the file and capped the output at 300
       * characters — and the `"name"` line sits past that cap, so the regex
       * matched neither when confined nor when not. It passed against the bug.
       * Matching a short distinctive string avoids depending on where in the
       * file the evidence happens to live.
       */
      const out = await createAndTest(
        manager,
        "leak-probe",
        `grep -o '"name": "reaper"' /work/package.json || true`,
      );

      assert.doesNotMatch(
        stdoutOf(out),
        /reaper/,
        `a validation command must not read the Reaper checkout, got: ${JSON.stringify(stdoutOf(out).slice(0, 200))}`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "a skill validation command cannot read the Reaper environment file",
  { skip: !sandboxAvailable },
  async () => {
    const { root, workspaceRoot, userHome } = await fixture("reaper-skill-env-");
    try {
      const manager = managerFor(workspaceRoot, userHome);
      const out = await createAndTest(manager, "env-probe", "cat /work/.env 2>&1 | head -c 300 || true");

      const stdout = stdoutOf(out);
      assert.doesNotMatch(
        stdout,
        /(API_KEY|SECRET|TOKEN|PASSWORD)\s*=/i,
        `a validation command must not read Reaper's env file, got: ${JSON.stringify(stdout.slice(0, 200))}`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
