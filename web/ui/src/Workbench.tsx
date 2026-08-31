/**
 * The workbench. Chat drives on the left; this shows on the right.
 *
 * Panes switch mode rather than occupying fixed tabs — with four surfaces
 * competing for one column, fixed tabs would waste most of it. (Structural
 * idea studied from Termany, which is AGPL: no code or values were copied.)
 *
 * **Follow Mode** (from Uatu, MIT): when the agent edits a file, open it. The
 * load-bearing detail from Uatu is that Follow controls only the *jumping* —
 * an already-open file refreshes either way. That separation is what makes the
 * toggle safe to leave on, so it is preserved here.
 */

import { createEffect, createResource, createSignal, For, Show, type JSX } from "solid-js";

type Mode = "files" | "diff";

interface TreeEntry {
  name: string;
  path: string;
  type: "file" | "directory";
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json() as Promise<T>;
}

export function Workbench(props: {
  baseUrl: string;
  /** Path of the file the agent most recently touched, or undefined. */
  lastEditedPath: string | undefined;
}): JSX.Element {
  const [mode, setMode] = createSignal<Mode>("files");
  const [follow, setFollow] = createSignal(true);
  const [dir, setDir] = createSignal(".");
  const [selected, setSelected] = createSignal<string | undefined>();

  const [entries] = createResource(dir, (path) =>
    fetchJson<{ entries: TreeEntry[] }>(`${props.baseUrl}/api/files?path=${encodeURIComponent(path)}`)
      .then((result) => result.entries)
      .catch(() => [] as TreeEntry[]),
  );

  const [file] = createResource(selected, (path) =>
    fetchJson<{ contents: string; truncated: boolean }>(
      `${props.baseUrl}/api/file?path=${encodeURIComponent(path)}`,
    ).catch(() => ({ contents: "", truncated: false })),
  );

  const [diff] = createResource(
    () => (mode() === "diff" ? (selected() ?? "") : undefined),
    (path) =>
      fetchJson<{ diff: string }>(
        `${props.baseUrl}/api/git/diff${path ? `?path=${encodeURIComponent(path)}` : ""}`,
      )
        .then((result) => result.diff)
        .catch(() => ""),
  );

  // Follow Mode: jump to what the agent just edited. Gated on the toggle,
  // because an unrequested jump while the user is reading something else is
  // the exact behavior that makes people turn these features off.
  createEffect(() => {
    const path = props.lastEditedPath;
    if (!follow() || !path) return;
    setSelected(path);
    setMode("files");
  });

  return (
    <div class="workbench">
      <div class="tabs" role="tablist">
        <button class="tab" role="tab" aria-selected={mode() === "files"} onClick={() => setMode("files")}>
          Files
        </button>
        <button class="tab" role="tab" aria-selected={mode() === "diff"} onClick={() => setMode("diff")}>
          Diff
        </button>
        <label class="toggle" style={{ "margin-left": "auto" }}>
          <input type="checkbox" checked={follow()} onChange={(event) => setFollow(event.currentTarget.checked)} />
          Follow
        </label>
      </div>

      <div class="workbench-body">
        <Show when={mode() === "files"}>
          <Show when={selected()} fallback={
            <div class="file-tree">
              <Show when={dir() !== "."}>
                <button class="tree-entry" onClick={() => setDir(parentOf(dir()))}>‹ up</button>
              </Show>
              <For each={entries()} fallback={<p class="empty">Empty directory</p>}>
                {(entry) => (
                  <button
                    class="tree-entry"
                    onClick={() => (entry.type === "directory" ? setDir(entry.path) : setSelected(entry.path))}
                  >
                    <span aria-hidden="true">{entry.type === "directory" ? "▸" : "·"}</span>
                    {entry.name}
                  </button>
                )}
              </For>
            </div>
          }>
            <div>
              <button class="tree-entry" onClick={() => setSelected(undefined)}>‹ back to files</button>
              <div class="tool-row"><span class="tool-detail">{selected()}</span></div>
              <pre class="output" style={{ "max-height": "none" }}>{file()?.contents ?? ""}</pre>
              <Show when={file()?.truncated}>
                <p class="empty">File truncated at 2 MB.</p>
              </Show>
            </div>
          </Show>
        </Show>

        <Show when={mode() === "diff"}>
          <Show when={diff()} fallback={<p class="empty">No uncommitted changes.</p>}>
            <div class="diff">
              <For each={(diff() ?? "").split("\n")}>
                {(line) => <div class="diff-line" data-kind={diffKind(line)}>{line || " "}</div>}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
}

function parentOf(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/") || ".";
}

function diffKind(line: string): "add" | "del" | "meta" | "ctx" {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}
