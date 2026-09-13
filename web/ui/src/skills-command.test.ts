import { describe, expect, it } from "vitest";

import { describeSkillCost, parseSkillsCommand, pinBlockReason, skillInvocationSuffix } from "./skills-command.js";
import type { SkillEntry } from "./settings.js";

function skill(overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    name: "codemode",
    description: "Write and use the eval tool well.",
    category: "prompt-enhancement",
    trust: "builtin",
    scope: "builtin",
    disabled: false,
    validated: true,
    ...overrides,
  };
}

describe("parseSkillsCommand", () => {
  it("recognizes the bare command", () => {
    expect(parseSkillsCommand("/skills")).toEqual({ kind: "overlay" });
    expect(parseSkillsCommand("  /skills  ")).toEqual({ kind: "overlay" });
  });

  it("treats trailing words as a filter", () => {
    expect(parseSkillsCommand("/skills github")).toEqual({ kind: "overlay", filter: "github" });
    expect(parseSkillsCommand("/skills release checklist")).toEqual({ kind: "overlay", filter: "release checklist" });
  });

  it("recognizes the subcommands", () => {
    expect(parseSkillsCommand("/skills pin codemode")).toEqual({ kind: "pin", name: "codemode" });
    expect(parseSkillsCommand("/skills unpin codemode")).toEqual({ kind: "unpin", name: "codemode" });
    expect(parseSkillsCommand("/skills show codemode")).toEqual({ kind: "show", name: "codemode" });
  });

  it("falls back to the overlay when a subcommand has no argument", () => {
    // `/skills pin` alone is a half-typed command, not an error worth a banner.
    // Opening the list is the useful reading.
    expect(parseSkillsCommand("/skills pin")).toEqual({ kind: "overlay" });
    expect(parseSkillsCommand("/skills unpin")).toEqual({ kind: "overlay" });
  });

  it("does not fire on prose that merely starts with the word", () => {
    expect(parseSkillsCommand("skills list")).toBeUndefined();
    expect(parseSkillsCommand("/skill")).toBeUndefined();
    expect(parseSkillsCommand("/skillsy")).toBeUndefined();
  });

  it("does not fire on a command that has grown a second line", () => {
    // By then it is a message that happens to start with `/skills`, and
    // swallowing it would delete something the user wrote.
    expect(parseSkillsCommand("/skills\nand then explain what it does")).toBeUndefined();
    expect(parseSkillsCommand("/skills pin codemode\nplease")).toBeUndefined();
  });

  it("leaves ordinary messages and other slashes alone", () => {
    expect(parseSkillsCommand("fix the bug")).toBeUndefined();
    expect(parseSkillsCommand("/codemode fix the bug")).toBeUndefined();
    expect(parseSkillsCommand("run ls /tmp")).toBeUndefined();
    expect(parseSkillsCommand("")).toBeUndefined();
  });
});

describe("skillInvocationSuffix", () => {
  it("recognizes a slash-prefixed skill name at the start of the draft", () => {
    const result = skillInvocationSuffix("/codemode refactor this", [skill()]);
    expect(result?.skill.name).toBe("codemode");
    expect(result?.suffix).toBe(" refactor this");
  });

  it("recognizes it with no message after it", () => {
    const result = skillInvocationSuffix("/codemode", [skill()]);
    expect(result?.skill.name).toBe("codemode");
    expect(result?.suffix).toBe("");
  });

  it("tolerates leading whitespace, which the server's own matcher allows", () => {
    expect(skillInvocationSuffix("  /codemode go", [skill()])?.skill.name).toBe("codemode");
  });

  it("matches case-insensitively but keeps the skill's own spelling", () => {
    expect(skillInvocationSuffix("/CodeMode go", [skill()])?.skill.name).toBe("codemode");
  });

  it("is not fooled by an unknown name", () => {
    expect(skillInvocationSuffix("/nope go", [skill()])).toBeUndefined();
  });

  it("does not fire mid-sentence", () => {
    // The whole reason the rule is anchored: a body is an instruction, and it
    // must never arrive because someone wrote a path.
    expect(skillInvocationSuffix("run /codemode now", [skill()])).toBeUndefined();
    expect(skillInvocationSuffix("see /usr/bin", [skill({ name: "usr" })])).toBeUndefined();
  });

  it("defers to the /skills command", () => {
    expect(skillInvocationSuffix("/skills list", [skill({ name: "skills" })])).toBeUndefined();
  });
});

describe("pinBlockReason", () => {
  it("allows an ordinary skill", () => {
    expect(pinBlockReason(skill())).toBeUndefined();
  });

  it("refuses a disabled one, preferring its own stated reason", () => {
    expect(pinBlockReason(skill({ disabled: true, disabledReason: "missing dependency" }))).toBe("missing dependency");
    expect(pinBlockReason(skill({ disabled: true }))).toBe("disabled");
  });

  it("refuses a skill from an untrusted project", () => {
    // The trust gate is upstream of pinning, and the UI must say so rather
    // than offering a switch that the server would then have to ignore.
    expect(pinBlockReason(skill({ trust: "project-untrusted" }))).toBe("this project is not trusted");
  });

  it("refuses a draft", () => {
    expect(pinBlockReason(skill({ trust: "draft" }))).toBe("drafts are not loaded into turns");
  });
});

describe("describeSkillCost", () => {
  it("counts characters, not vibes", () => {
    expect(describeSkillCost("x".repeat(300))).toBe("300 chars in every turn");
    expect(describeSkillCost("x".repeat(2_400))).toBe("2.4k chars in every turn");
  });
});
