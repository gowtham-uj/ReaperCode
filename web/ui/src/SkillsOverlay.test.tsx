import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonRpcClient } from "@reaper/web-shared";

import { SkillsOverlay } from "./SkillsOverlay.js";
import type { SettingsStore, SkillEntry, SettingsState } from "./settings.js";

afterEach(cleanup);

const client = {} as JsonRpcClient;

function skill(overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    name: "codemode",
    description: "Write and run JavaScript through the eval tool.",
    category: "prompt-enhancement",
    trust: "builtin",
    scope: "builtin",
    disabled: false,
    validated: true,
    ...overrides,
  };
}

function store(
  overrides: Partial<SettingsStore> = {},
  pinnedSkills: string[] = [],
  disabledSkills: string[] = [],
): SettingsStore {
  const settings: SettingsState = {
    fileExists: true,
    permissionMode: "auto",
    modelRouting: {},
    models: [],
    pinnedSkills,
    disabledSkills,
    disabledProviders: [],
    restartsRequired: false,
  };
  return {
    settings,
    skills: [skill()],
    skillErrors: [],
    extensions: [],
    extensionErrors: [],
    policyRules: [],
    policyFileExists: false,
    loading: false,
    error: undefined,
    refreshSettings: vi.fn(async () => undefined),
    saveSettings: vi.fn(async () => undefined),
    refreshSkills: vi.fn(async () => undefined),
    refreshExtensions: vi.fn(async () => undefined),
    refreshPolicy: vi.fn(async () => undefined),
    savePolicy: vi.fn(async () => undefined),
    ...overrides,
  };
}

function open(
  overrides: Partial<SettingsStore> = {},
  pinnedSkills: string[] = [],
  props: Partial<Parameters<typeof SkillsOverlay>[0]> = {},
  disabledSkills: string[] = [],
) {
  const handlers = { onClose: vi.fn(), onUse: vi.fn(), onError: vi.fn() };
  const settingsStore = store(overrides, pinnedSkills, disabledSkills);
  render(
    <SkillsOverlay
      store={settingsStore}
      client={client}
      onClose={handlers.onClose}
      onUse={handlers.onUse}
      onError={handlers.onError}
      {...props}
    />,
  );
  return { ...handlers, store: settingsStore };
}

function row(name: string): HTMLElement {
  const cell = screen.getByText(name).closest("li");
  if (!cell) throw new Error(`no row for ${name}`);
  return cell as HTMLElement;
}

/** The trust badge specifically — `scope` often carries the same word. */
function trustOf(name: string): string {
  return row(name).querySelector(".trust-badge")?.textContent ?? "";
}

describe("SkillsOverlay", () => {
  it("opens the dialog and lists what is installed", () => {
    open({ skills: [skill(), skill({ name: "release", description: "Cut a release.", scope: "user", trust: "user-trusted" })] });

    // The dialog must actually be open: a `<dialog>` that renders its children
    // without `open` is invisible in a real browser but perfectly queryable in
    // jsdom, so asserting on the text alone would pass on a broken overlay.
    expect(screen.getByRole("dialog")).toHaveProperty("open", true);
    expect(screen.getByRole("heading", { name: "Skills" })).toBeTruthy();
    expect(screen.getByText("codemode")).toBeTruthy();
    expect(screen.getByText("release")).toBeTruthy();
    expect(screen.getByText("2 installed")).toBeTruthy();
    expect(trustOf("codemode")).toBe("builtin");
    expect(trustOf("release")).toBe("user-trusted");
  });

  it("refreshes the list when it opens", () => {
    const refreshSkills = vi.fn(async () => undefined);
    open({ refreshSkills });
    expect(refreshSkills).toHaveBeenCalledWith(client);
  });

  it("marks an always-on skill three ways, not just by colour", () => {
    open({}, ["codemode"]);
    const pinned = row("codemode");

    expect(pinned.dataset.pinned).toBe("true");
    expect(within(pinned).getByText("always on")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Turn off always-on for codemode" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("pins by writing the whole replacement set", async () => {
    const saveSettings = vi.fn(async () => undefined);
    const { onError } = open({ saveSettings, skills: [skill(), skill({ name: "release" })] }, ["release"]);

    await userEvent.click(screen.getByRole("button", { name: "Make codemode always on" }));

    // Wholesale, and order-preserving: the server stores exactly this array, so
    // an add that dropped `release` would silently unpin it.
    expect(saveSettings).toHaveBeenCalledWith(client, { pinnedSkills: ["release", "codemode"] });
    expect(onError).toHaveBeenCalledWith(undefined);
    expect(screen.getByRole("status").textContent).toContain("every turn");
  });

  it("unpins by removing exactly that one name", async () => {
    const saveSettings = vi.fn(async () => undefined);
    open({ saveSettings, skills: [skill(), skill({ name: "release" })] }, ["release", "codemode"]);

    await userEvent.click(screen.getByRole("button", { name: "Turn off always-on for codemode" }));

    expect(saveSettings).toHaveBeenCalledWith(client, { pinnedSkills: ["release"] });
  });

  /*
   * Switching a skill off.
   *
   * The three assertions that matter are the payload (the whole set, so a
   * toggle cannot silently clear the others), the interaction rule (a skill
   * cannot be both always-on and off), and the refetch — the list is what the
   * row reads for its own disabled reason, so a write that did not refresh
   * would leave the badge disagreeing with the button that produced it.
   */
  it("switches a skill off by writing the whole set, and refetches the list", async () => {
    const saveSettings = vi.fn(async () => undefined);
    const refreshSkills = vi.fn(async () => undefined);
    open({ saveSettings, refreshSkills, skills: [skill(), skill({ name: "release" })] });

    await userEvent.click(screen.getByRole("button", { name: "Switch codemode off" }));

    expect(saveSettings).toHaveBeenCalledWith(client, { disabledSkills: ["codemode"] });
    expect(refreshSkills).toHaveBeenCalledWith(client);
    expect(screen.getByRole("status").textContent).toContain("not offered to the model");
  });

  it("refuses to pin a skill that is switched off, rather than storing a pin that will be dropped", () => {
    open({}, [], {}, ["codemode"]);
    const pin = screen.getByRole("button", { name: "Make codemode always on" }) as HTMLButtonElement;

    // The server drops the pin at resolution time because a disabled skill's
    // body is never injected. Storing it anyway would put "always on" on a row
    // whose skill is not in the prompt — a screen that lies.
    expect(pin.disabled).toBe(true);
    expect(row("codemode").dataset.off).toBe("true");
    expect(within(row("codemode")).getByText("off")).toBeTruthy();
  });

  it("clears the always-on flag in the same write when a skill is switched off", async () => {
    const saveSettings = vi.fn(async () => undefined);
    open({ saveSettings }, ["codemode"]);

    await userEvent.click(screen.getByRole("button", { name: "Switch codemode off" }));

    // One write, both fields: two calls could interleave with another client's
    // edit and land in a state neither asked for.
    expect(saveSettings).toHaveBeenCalledWith(client, { disabledSkills: ["codemode"], pinnedSkills: [] });
  });

  it("switches a skill back on with a second click", async () => {
    const saveSettings = vi.fn(async () => undefined);
    open({ saveSettings }, [], {}, ["codemode"]);

    await userEvent.click(screen.getByRole("button", { name: "Switch codemode on" }));

    expect(saveSettings).toHaveBeenCalledWith(client, { disabledSkills: [] });
    expect(screen.getByRole("status").textContent).toContain("on again");
  });

  it("surfaces a failed write instead of pretending the pin landed", async () => {
    const saveSettings = vi.fn(async () => { throw new Error("config is invalid"); });
    const { onError } = open({ saveSettings });

    await userEvent.click(screen.getByRole("button", { name: "Make codemode always on" }));

    expect(onError).toHaveBeenCalledWith("config is invalid");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("refuses to offer always-on for a skill the turn path would ignore", () => {
    open({
      skills: [
        skill({ name: "untrusted", trust: "project-untrusted" }),
        skill({ name: "sketch", trust: "draft" }),
        skill({ name: "broken", disabled: true, disabledReason: "missing dependency" }),
      ],
    });

    const untrusted = screen.getByRole("button", { name: "Make untrusted always on" });
    expect(untrusted).toHaveProperty("disabled", true);
    expect(untrusted.getAttribute("title")).toBe("this project is not trusted");
    expect(screen.getByRole("button", { name: "Make sketch always on" }).getAttribute("title"))
      .toBe("drafts are not loaded into turns");
    expect(screen.getByRole("button", { name: "Make broken always on" }).getAttribute("title"))
      .toBe("missing dependency");
  });

  it("still lets a blocked skill be turned off, so a pin can never get stuck", () => {
    // Trust can be revoked after a pin was made. If the toggle were disabled in
    // both directions the name would sit in settings forever with no way out.
    open({ skills: [skill({ name: "untrusted", trust: "project-untrusted" })] }, ["untrusted"]);
    expect(screen.getByRole("button", { name: "Turn off always-on for untrusted" })).toHaveProperty("disabled", false);
  });

  it("hands a skill to the composer rather than running it here", async () => {
    const { onUse } = open();
    await userEvent.click(screen.getByRole("button", { name: "Use codemode in the next message" }));
    expect(onUse).toHaveBeenCalledWith("codemode");
  });

  it("filters by name, description, and category", async () => {
    open({
      skills: [
        skill(),
        skill({ name: "release", description: "Cut a release.", category: "workflow" }),
      ],
    });

    const filter = screen.getByRole("searchbox", { name: "Filter skills" });
    await userEvent.type(filter, "workflow");
    expect(screen.queryByText("codemode")).toBeNull();
    expect(screen.getByText("release")).toBeTruthy();

    await userEvent.clear(filter);
    await userEvent.type(filter, "JavaScript");
    expect(screen.getByText("codemode")).toBeTruthy();
    expect(screen.queryByText("release")).toBeNull();
  });

  it("says so when nothing matches", async () => {
    open();
    await userEvent.type(screen.getByRole("searchbox", { name: "Filter skills" }), "zzz");
    expect(screen.getByText("Nothing matches “zzz”.")).toBeTruthy();
  });

  it("lets the first Escape clear the filter and the second close", async () => {
    const { onClose } = open();
    const filter = screen.getByRole("searchbox", { name: "Filter skills" });

    await userEvent.type(filter, "zzz");
    await userEvent.keyboard("{Escape}");
    expect(filter).toHaveProperty("value", "");
    expect(onClose).not.toHaveBeenCalled();

    // jsdom does not implement Escape-cancels-dialog, so the second press is
    // asserted at the layer this component owns: `onClose` is wired to the
    // element's own `close` event, which is what the browser fires.
    (screen.getByRole("dialog") as HTMLDialogElement).close();
    expect(onClose).toHaveBeenCalled();
  });

  it("caps the unfiltered list but never the search", async () => {
    const many = Array.from({ length: 75 }, (_, index) => skill({ name: `skill-${index}`, description: `number ${index}` }));
    open({ skills: many });

    expect(screen.getAllByRole("listitem")).toHaveLength(60);
    await userEvent.click(screen.getByRole("button", { name: "Show 15 more" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(75);
  });

  it("names the always-on set in the footer", () => {
    open({ skills: [skill(), skill({ name: "release" })] }, ["codemode", "release"]);
    expect(screen.getByText(/always on: codemode, release/)).toBeTruthy();
  });

  it("says nothing is always on when nothing is", () => {
    open();
    expect(screen.getByText("No skills are always on.")).toBeTruthy();
  });

  it("reports skill files it could not read", () => {
    open({ skillErrors: [{ path: "/w/.reaper/skills/broken.md", error: "bad frontmatter" }] });
    expect(screen.getByRole("alert").textContent).toContain("/w/.reaper/skills/broken.md");
  });

  it("points somewhere useful when there are no skills at all", () => {
    open({ skills: [] });
    expect(screen.getByText(/No skills are installed/)).toBeTruthy();
  });

  it("opens pre-filtered when the command carried a name", () => {
    open({ skills: [skill(), skill({ name: "release" })] }, [], { initialFilter: "release" });
    expect(screen.getByText("release")).toBeTruthy();
    expect(screen.queryByText("codemode")).toBeNull();
  });

  it("does not offer to pin while there is no connection to write through", () => {
    const handlers = { onClose: vi.fn(), onUse: vi.fn(), onError: vi.fn() };
    render(<SkillsOverlay store={store()} client={undefined} {...handlers} />);
    expect(screen.getByRole("button", { name: "Make codemode always on" })).toHaveProperty("disabled", true);
  });
});
