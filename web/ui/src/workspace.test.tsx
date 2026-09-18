import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonRpcClient } from "@reaper/web-shared";

import type { BackgroundState } from "./background.js";
import { ThreadList, threadLabel } from "./ThreadList.js";
import { Workbench } from "./Workbench.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const client = {} as JsonRpcClient;

describe("thread workspace controls", () => {
  it("never exposes a machine-generated id as the visible thread name", () => {
    expect(threadLabel({ id: "807fc1cb-1dc7-40c8-a7b9-334e7370d3ac" })).toBe("Untitled thread");
    expect(threadLabel({ id: "thread-1", name: "Provider onboarding" })).toBe("Provider onboarding");
  });

  it("creates either a fresh isolated thread or a thread pointed at an existing project", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => "test-thread");
    render(
      <ThreadList
        client={client}
        activeThreadId="thread-1"
        threads={[]}
        loading={false}
        onRefresh={vi.fn()}
        onCreate={onCreate}
        onSwitch={vi.fn(async () => undefined)}
      />,
    );

    /*
     * Creating a thread asks for a name and nothing else. The workspace is a
     * per-thread setting, not a precondition for starting a chat — asking for
     * a directory here put an optional, rarely-changed decision in front of
     * the one thing this form is for.
     */
    await user.click(screen.getByRole("button", { name: "New thread" }));
    await user.type(screen.getByLabelText(/Name/), "Fresh task");
    expect(screen.queryByLabelText(/Existing project/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(onCreate).toHaveBeenNthCalledWith(1, { title: "Fresh task" });

    await user.click(screen.getByRole("button", { name: "New thread" }));
    await user.type(screen.getByLabelText(/^Name$/), "Second task");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(onCreate).toHaveBeenNthCalledWith(2, { title: "Second task" });
  });

  it("does not offer a second creation control while the form is open", async () => {
    const user = userEvent.setup();
    render(
      <ThreadList
        client={client}
        activeThreadId="thread-1"
        threads={[]}
        loading={false}
        onRefresh={vi.fn()}
        onCreate={vi.fn(async () => "test-thread")}
        onSwitch={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.getAllByRole("button", { name: "New thread" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "New thread" }));
    // The form opened at the top; the button that opened it is gone, so there
    // is exactly one way to create a thread at any moment.
    expect(screen.queryByRole("button", { name: "New thread" })).toBeNull();
    expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
  });

  it("switches from the labelled thread list", async () => {
    const user = userEvent.setup();
    const onSwitch = vi.fn(async () => undefined);
    render(
      <ThreadList
        client={client}
        activeThreadId="thread-a"
        threads={[
          { id: "thread-a", name: "First", cwd: "/tmp/a" },
          { id: "thread-b", name: "Second", cwd: "/tmp/b" },
        ]}
        loading={false}
        onRefresh={vi.fn()}
        onCreate={vi.fn(async () => "test-thread")}
        onSwitch={onSwitch}
      />,
    );
    expect(screen.getByText("Threads")).toBeTruthy();
    /*
     * Not `/Second/`: the row now carries a delete control whose accessible name
     * is "Delete Second", so a bare name pattern matches two buttons and the
     * query is ambiguous. The switch control is the one whose name starts with
     * the thread's own name; the delete control's starts with "Delete".
     */
    await user.click(screen.getByRole("button", { name: /^Second\b/ }));
    expect(onSwitch).toHaveBeenCalledWith("thread-b");
  });
});

describe("thread-scoped workbench requests", () => {
  it("carries the selected thread id in file and diff requests", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("/api/git/diff") ? { diff: "" } : { entries: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const background: BackgroundState = {
      processes: [],
      servers: [],
      ingest: vi.fn(() => false),
      clear: vi.fn(),
    };
    const user = userEvent.setup();
    const { rerender } = render(
      <Workbench
        baseUrl=""
        threadId="thread-a"
        lastEditedPath={undefined} workspaceRevision={0}
        background={background}
        browser={undefined}
      />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/files?threadId=thread-a&path=.",
      expect.any(Object),
    ));

    rerender(
      <Workbench
        baseUrl=""
        threadId="thread-b"
        lastEditedPath={undefined} workspaceRevision={0}
        background={background}
        browser={undefined}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "Diff" }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/git/diff?threadId=thread-b"))).toBe(true);
    });
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes("threadId=undefined"))).toBe(true);
  });

  it("refetches the file tree when the agent edits the workspace", async () => {
    // The tree's request URL never changes while a thread is open — the agent
    // writes to disk behind it — so a cache keyed on the request alone kept
    // serving the listing from open time and a file the agent had just created
    // stayed invisible. `workspaceRevision` is what makes it refetch.
    // Typed with the arguments so `mock.calls` carries the URL tuple the
    // assertions below destructure; a zero-arg vi.fn() types it as `[]`.
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      new Response(JSON.stringify({ entries: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const background: BackgroundState = { processes: [], servers: [], ingest: vi.fn(() => false), clear: vi.fn() };
    const tree = (workspaceRevision: number) => (
      <Workbench
        baseUrl=""
        threadId="thread-a"
        lastEditedPath={undefined}
        workspaceRevision={workspaceRevision}
        background={background}
        browser={undefined}
      />
    );

    const { rerender } = render(tree(0));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/files?threadId=thread-a&path=."))).toBe(true));

    const before = fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/files")).length;
    rerender(tree(1));

    await waitFor(() => {
      const after = fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/files")).length;
      expect(after).toBeGreaterThan(before);
    });
  });
});
