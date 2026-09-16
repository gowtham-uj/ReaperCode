/**
 * The mapping layer, tested where it does the thing it was written for:
 * resolving a tool this build has never heard of.
 *
 * The exact-name table is a lookup and testing it is testing a literal. What
 * earns a test is the shape matching, because that is the part that has to hold
 * for a plugin's tool nobody anticipated, and the part that silently produces a
 * wrong glyph rather than an error when it does not.
 */
import { describe, expect, it } from "vitest";

import { getToolPresentation, isTestCommand } from "./tool-presentation.js";

describe("tool presentation", () => {
  it("resolves this build's own tools by name", () => {
    expect(getToolPresentation("grep_search").category).toBe("search");
    expect(getToolPresentation("file_view").category).toBe("read");
    expect(getToolPresentation("apply_patch_edit").category).toBe("edit");
    expect(getToolPresentation("eval").category).toBe("eval");
  });

  it("resolves tools it has never seen by the shape of the name", () => {
    expect(getToolPresentation("ripgrep").category).toBe("search");
    expect(getToolPresentation("notion_search").category).toBe("search");
    expect(getToolPresentation("read_file").category).toBe("read");
    expect(getToolPresentation("apply_patch").category).toBe("edit");
    expect(getToolPresentation("run_tests").category).toBe("test");
    expect(getToolPresentation("shell_exec").category).toBe("command");
    expect(getToolPresentation("spawn_agent").category).toBe("agent");
  });

  it("gives anything unrecognised a neutral treatment rather than nothing", () => {
    const unknown = getToolPresentation("zxq_frobnicate");
    expect(unknown.category).toBe("generic");
    expect(unknown.icon).toBe("generic");
    expect(unknown.countsResults).toBe(false);
  });

  it("counts results only where a count is the finding", () => {
    expect(getToolPresentation("grep_search").countsResults).toBe(true);
    // A "412 lines" note beside a file read is filler.
    expect(getToolPresentation("file_view").countsResults).toBe(false);
  });

  it("is case insensitive, because tool names arrive from providers", () => {
    expect(getToolPresentation("Grep_Search").category).toBe("search");
  });

  it("recognises a test run without parsing its output", () => {
    expect(isTestCommand("npm test -- auth")).toBe(true);
    expect(isTestCommand("pnpm vitest run")).toBe(true);
    expect(isTestCommand("cargo test")).toBe(true);
    expect(isTestCommand("npm run build")).toBe(false);
  });

  /*
   * The word "test" appearing in a command is not the test being run.
   *
   * The first version matched the substring anywhere, so a grep whose only sin
   * was searching a directory called `tests` was drawn as a test run with a
   * test-tube glyph. That happened in a real session, where the transcript
   * claimed a test run for a command that only read files.
   */
  it("does not mistake a path or a package name for a test run", () => {
    expect(isTestCommand('grep -rn "reconcileTrust" /work/src /work/tests | grep -v node_modules')).toBe(false);
    expect(isTestCommand("ls -la /work/tests")).toBe(false);
    expect(isTestCommand("npm ls jest")).toBe(false);
    expect(isTestCommand("cat src/foo.test.ts")).toBe(false);
    expect(isTestCommand("node --test --no-tests thing.js")).toBe(false);
  });

  it("still sees a runner through the wrapper that invokes it", () => {
    expect(isTestCommand("npx vitest run")).toBe(true);
    expect(isTestCommand("sudo -E pytest -q")).toBe(true);
    expect(isTestCommand("/usr/bin/pytest")).toBe(true);
    expect(isTestCommand("npm run lint && npm test")).toBe(true);
  });
});
