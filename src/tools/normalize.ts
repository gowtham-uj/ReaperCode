import { randomUUID } from "node:crypto";

export function normalizeToolCall(input: unknown): unknown {
  if (!input || typeof input !== "object") {
    return input;
  }

  const raw = input as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id : randomUUID();
  const rawName =
    typeof raw.name === "string"
      ? raw.name
      : typeof raw.toolName === "string"
        ? raw.toolName
        : typeof raw.tool_name === "string"
          ? raw.tool_name
          : typeof raw.tool === "string"
            ? raw.tool
            : undefined;

  let args: unknown = raw.args;
  if (typeof raw.arguments === "string") {
    try {
      args = JSON.parse(raw.arguments);
    } catch {
      args = { rawArguments: raw.arguments };
    }
  } else if (raw.arguments && typeof raw.arguments === "object") {
    args = raw.arguments;
  } else if (raw.function && typeof raw.function === "object") {
    const fn = raw.function as Record<string, unknown>;
    if (typeof fn.arguments === "string") {
      try {
        args = JSON.parse(fn.arguments);
      } catch {
        args = { rawArguments: fn.arguments };
      }
    } else if (fn.arguments && typeof fn.arguments === "object") {
      args = fn.arguments;
    }
  } else if (raw.toolArgs && typeof raw.toolArgs === "object") {
    args = raw.toolArgs;
  } else if (raw.toolArguments && typeof raw.toolArguments === "object") {
    args = raw.toolArguments;
  } else if (raw.parameters && typeof raw.parameters === "object") {
    args = raw.parameters;
  }

  const inferredName = normalizeToolName(rawName, args);
  let normalizedName = inferredName;

  if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;

    // Normalize common arg aliases
    const normalizedPath =
      typeof record.path === "string"
        ? record.path
        : typeof record.filePath === "string"
          ? record.filePath
          : typeof raw.toolPath === "string"
            ? raw.toolPath
            : typeof raw.path === "string"
              ? raw.path
              : typeof raw.filePath === "string"
                ? raw.filePath
                : undefined;
    const normalizedWorkspacePath = normalizeContainerWorkspacePath(normalizedPath);

    const normalizedOld =
      typeof record.oldString === "string"
        ? record.oldString
        : typeof record.old_str === "string"
          ? record.old_str
          : typeof record.old_string === "string"
            ? record.old_string
            : typeof record.oldContent === "string"
              ? record.oldContent
              : typeof raw.old_str === "string"
                ? raw.old_str
                : typeof raw.old_string === "string"
                  ? raw.old_string
                  : undefined;

    const normalizedNew =
      typeof record.newString === "string"
        ? record.newString
        : typeof record.new_str === "string"
          ? record.new_str
          : typeof record.new_string === "string"
            ? record.new_string
            : typeof record.newContent === "string"
              ? record.newContent
              : typeof raw.new_str === "string"
                ? raw.new_str
                : typeof raw.new_string === "string"
                  ? raw.new_string
                  : undefined;

    const normalizedCmd = typeof record.cmd === "string" ? record.cmd : undefined;

    const normalizedStepId =
      typeof record.stepId === "string"
        ? record.stepId
        : typeof record.step_id === "string"
          ? record.step_id
          : undefined;

    let name = normalizeToolName(rawName, args);
    normalizedName = name;
    switch (name) {
      case "read_file":
      case "view_file":
        args = {
          ...(normalizedWorkspacePath ? { path: normalizedWorkspacePath } : {}),
          ...(typeof record.startLine === "number" ? { startLine: record.startLine } : {}),
          ...(typeof record.endLine === "number" ? { endLine: record.endLine } : {}),
        };
        break;
      case "list_directory":
        args = {
          ...(normalizedWorkspacePath ? { path: normalizedWorkspacePath } : {}),
          ...(typeof record.includeHidden === "boolean" ? { includeHidden: record.includeHidden } : {}),
        };
        break;
      case "grep_search":
        args = {
          ...(typeof record.pattern === "string" ? { pattern: record.pattern } : {}),
          ...(normalizedWorkspacePath ? { path: normalizedWorkspacePath } : {}),
          ...(typeof record.include === "string" ? { include: record.include } : {}),
        };
        break;
      case "skim_file":
        args = {
          ...(normalizedWorkspacePath ? { path: normalizedWorkspacePath } : {}),
          ...(typeof record.goalHint === "string" ? { goalHint: record.goalHint } : {}),
        };
        break;
      case "inspect_environment":
        args = {};
        break;
      case "web_search":
        args = {
          ...(typeof record.query === "string" ? { query: record.query } : {}),
          ...(typeof record.engine === "string" ? { engine: record.engine } : {}),
          ...(typeof record.maxResults === "number" ? { maxResults: record.maxResults } : {}),
          ...(typeof record.scrapePages === "number" ? { scrapePages: record.scrapePages } : {}),
        };
        break;
      case "replace_in_file": {
        const startLine =
          typeof record.startLine === "number"
            ? record.startLine
            : typeof record.start_line === "number"
              ? record.start_line
              : undefined;
        const endLine =
          typeof record.endLine === "number"
            ? record.endLine
            : typeof record.end_line === "number"
              ? record.end_line
              : undefined;
        if (startLine !== undefined && endLine !== undefined && typeof record.content === "string") {
          args = {
            ...(normalizedWorkspacePath ? { path: normalizedWorkspacePath } : {}),
            startLine,
            endLine,
            content: record.content,
          };
        } else {
          args = {
            ...(normalizedWorkspacePath ? { path: normalizedWorkspacePath } : {}),
            ...(normalizedOld !== undefined ? { oldString: normalizedOld } : {}),
            ...(normalizedNew !== undefined ? { newString: normalizedNew } : {}),
            ...(typeof record.allowMultiple === "boolean" ? { allowMultiple: record.allowMultiple } : {}),
          };
        }
        break;
      }
      case "edit_file":
        args = {
          ...(normalizedWorkspacePath ? { path: normalizedWorkspacePath } : {}),
          ...(Array.isArray(record.edits) ? { edits: record.edits } : {}),
        };
        break;
      case "replace_symbol":
        args = {
          ...(normalizedWorkspacePath ? { path: normalizedWorkspacePath } : {}),
          ...(typeof record.symbolName === "string" ? { symbolName: record.symbolName } : {}),
          ...(typeof record.newCode === "string" ? { newCode: record.newCode } : {}),
        };
        break;
      case "write_file":
        args = {
          ...(normalizedWorkspacePath ? { path: normalizedWorkspacePath } : {}),
          ...(typeof record.content === "string" ? { content: record.content } : {}),
        };
        break;
      case "delete_file":
        args = {
          ...(normalizedWorkspacePath ? { path: normalizedWorkspacePath } : {}),
        };
        break;
      case "bash": {
        const timeout =
          typeof record.timeout === "number"
            ? record.timeout
            : typeof record.timeoutMs === "number"
              ? Math.max(1, Math.ceil(record.timeoutMs / 1000))
              : undefined;
        const description =
          typeof record.description === "string"
            ? record.description
            : typeof record.summary === "string"
              ? record.summary
              : undefined;
        args = {
          ...(normalizedCmd ? { cmd: normalizedCmd } : {}),
          ...(description ? { description } : {}),
          ...(timeout !== undefined ? { timeout } : {}),
          ...(typeof record.run_in_background === "boolean" ? { run_in_background: record.run_in_background } : {}),
        };
        break;
      }
      case "file_view":
        args = {
          ...(normalizedWorkspacePath ? { path: normalizedWorkspacePath } : {}),
          ...(typeof record.start_line === "number" ? { start_line: record.start_line } : {}),
          ...(typeof record.startLine === "number" ? { start_line: record.startLine } : {}),
          ...(typeof record.window === "number" ? { window: record.window } : {}),
          ...(typeof record.startLine === "number" ? { window: record.startLine } : {}),
        };
        break;
      case "file_scroll":
        args = {
          ...(normalizedWorkspacePath ? { path: normalizedWorkspacePath } : {}),
          ...(typeof record.direction === "string" ? { direction: record.direction } : {}),
          ...(typeof record.lines === "number" ? { lines: record.lines } : {}),
        };
        break;
      case "file_find":
        args = {
          ...(normalizedWorkspacePath ? { path: normalizedWorkspacePath } : {}),
          ...(typeof record.pattern === "string" ? { pattern: record.pattern } : {}),
          ...(typeof record.start_line === "number" ? { start_line: record.start_line } : {}),
          ...(typeof record.startLine === "number" ? { start_line: record.startLine } : {}),
        };
        break;
      case "file_edit":
        args = {
          ...(normalizedWorkspacePath ? { path: normalizedWorkspacePath } : {}),
          ...(typeof record.start_line === "number" ? { start_line: record.start_line } : {}),
          ...(typeof record.startLine === "number" ? { start_line: record.startLine } : {}),
          ...(typeof record.end_line === "number" ? { end_line: record.end_line } : {}),
          ...(typeof record.endLine === "number" ? { end_line: record.endLine } : {}),
          ...(typeof record.new_content === "string" ? { new_content: record.new_content } : {}),
          ...(typeof record.newContent === "string" ? { new_content: record.newContent } : {}),
          ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
        };
        break;
      case "browser_control":
        args = {
          ...(typeof record.action === "string" ? { action: record.action } : {}),
          ...(typeof record.url === "string" ? { url: record.url } : {}),
          ...(typeof record.selector === "string" ? { selector: record.selector } : {}),
          ...(typeof record.ref === "string" ? { ref: record.ref } : {}),
          ...(typeof record.text === "string" ? { text: record.text } : {}),
          ...(typeof record.key === "string" ? { key: record.key } : {}),
          ...(typeof record.value === "string" ? { value: record.value } : {}),
          ...(typeof record.x === "number" ? { x: record.x } : {}),
          ...(typeof record.y === "number" ? { y: record.y } : {}),
          ...(typeof record.deltaX === "number" ? { deltaX: record.deltaX } : {}),
          ...(typeof record.deltaY === "number" ? { deltaY: record.deltaY } : {}),
          ...(typeof record.button === "string" ? { button: record.button } : {}),
          ...(typeof record.clear === "boolean" ? { clear: record.clear } : {}),
          ...(typeof record.submit === "boolean" ? { submit: record.submit } : {}),
          ...(typeof record.humanize === "boolean" ? { humanize: record.humanize } : {}),
          ...(typeof record.headless === "boolean" ? { headless: record.headless } : {}),
          ...(typeof record.width === "number" ? { width: record.width } : {}),
          ...(typeof record.height === "number" ? { height: record.height } : {}),
          ...(typeof record.screenshot === "boolean" ? { screenshot: record.screenshot } : {}),
          ...(typeof record.fullPage === "boolean" ? { fullPage: record.fullPage } : {}),
          ...(typeof record.maxTextChars === "number" ? { maxTextChars: record.maxTextChars } : {}),
          ...(typeof record.maxInteractive === "number" ? { maxInteractive: record.maxInteractive } : {}),
          ...(typeof record.waitUntil === "string" ? { waitUntil: record.waitUntil } : {}),
          ...(typeof record.timeoutMs === "number" ? { timeoutMs: record.timeoutMs } : {}),
        };
        break;
      case "computer_control":
        args = {
          ...(typeof record.action === "string" ? { action: record.action } : {}),
          ...(typeof record.x === "number" ? { x: record.x } : {}),
          ...(typeof record.y === "number" ? { y: record.y } : {}),
          ...(typeof record.endX === "number" ? { endX: record.endX } : {}),
          ...(typeof record.endY === "number" ? { endY: record.endY } : {}),
          ...(typeof record.steps === "number" ? { steps: record.steps } : {}),
          ...(typeof record.text === "string" ? { text: record.text } : {}),
          ...(typeof record.key === "string" ? { key: record.key } : {}),
          ...(typeof record.deltaX === "number" ? { deltaX: record.deltaX } : {}),
          ...(typeof record.deltaY === "number" ? { deltaY: record.deltaY } : {}),
          ...(typeof record.button === "string" ? { button: record.button } : {}),
          ...(typeof record.humanize === "boolean" ? { humanize: record.humanize } : {}),
          ...(typeof record.headless === "boolean" ? { headless: record.headless } : {}),
          ...(typeof record.width === "number" ? { width: record.width } : {}),
          ...(typeof record.height === "number" ? { height: record.height } : {}),
          ...(typeof record.fullPage === "boolean" ? { fullPage: record.fullPage } : {}),
        };
        break;
      case "mouse_move":
        args = {
          ...(typeof record.x === "number" ? { x: record.x } : {}),
          ...(typeof record.y === "number" ? { y: record.y } : {}),
          ...(typeof record.duration === "number" ? { duration: record.duration } : {}),
        };
        break;
      case "mouse_click":
        args = {
          ...(typeof record.x === "number" ? { x: record.x } : {}),
          ...(typeof record.y === "number" ? { y: record.y } : {}),
          ...(typeof record.button === "string" ? { button: record.button } : {}),
          ...(typeof record.clicks === "number" ? { clicks: record.clicks } : {}),
          ...(typeof record.duration === "number" ? { duration: record.duration } : {}),
          ...(typeof record.jitterPx === "number" ? { jitterPx: record.jitterPx } : {}),
        };
        break;
      case "mouse_scroll":
        args = {
          ...(typeof record.deltaX === "number" ? { deltaX: record.deltaX } : {}),
          ...(typeof record.deltaY === "number" ? { deltaY: record.deltaY } : {}),
          ...(typeof record.delta_x === "number" ? { deltaX: record.delta_x } : {}),
          ...(typeof record.delta_y === "number" ? { deltaY: record.delta_y } : {}),
          ...(typeof record.inertia === "boolean" ? { inertia: record.inertia } : {}),
        };
        break;
      case "keyboard_type":
        args = {
          ...(typeof record.text === "string" ? { text: record.text } : {}),
          ...(typeof record.minDelay === "number" ? { minDelay: record.minDelay } : {}),
          ...(typeof record.maxDelay === "number" ? { maxDelay: record.maxDelay } : {}),
          ...(typeof record.min_delay === "number" ? { minDelay: record.min_delay } : {}),
          ...(typeof record.max_delay === "number" ? { maxDelay: record.max_delay } : {}),
          ...(typeof record.typoProbability === "number" ? { typoProbability: record.typoProbability } : {}),
          ...(typeof record.typo_probability === "number" ? { typoProbability: record.typo_probability } : {}),
        };
        break;
      case "keyboard_press":
        args = {
          ...(Array.isArray(record.keys) ? { keys: record.keys } : {}),
          ...(typeof record.key === "string" ? { keys: [record.key] } : {}),
          ...(typeof record.duration === "number" ? { duration: record.duration } : {}),
          ...(typeof record.authorized === "boolean" ? { authorized: record.authorized } : {}),
        };
        break;
      case "screenshot":
        args = {
          ...(record.region !== undefined ? { region: record.region } : {}),
          ...(typeof record.returnFormat === "string" ? { returnFormat: record.returnFormat } : {}),
          ...(typeof record.return_format === "string" ? { returnFormat: record.return_format } : {}),
        };
        break;
      case "get_screen_size":
      case "get_mouse_position":
      case "stop_live_view":
      case "is_human_intervening":
        args = {};
        break;
      case "wait":
        args = {
          ...(typeof record.seconds === "number" ? { seconds: record.seconds } : {}),
          ...(typeof record.jitter === "number" ? { jitter: record.jitter } : {}),
        };
        break;
      case "start_live_view":
        args = {
          ...(typeof record.host === "string" ? { host: record.host } : {}),
          ...(typeof record.port === "number" ? { port: record.port } : {}),
          ...(typeof record.fps === "number" ? { fps: record.fps } : {}),
        };
        break;
      case "request_human_approval":
        args = {
          ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
          ...(typeof record.contextScreenshot === "string" ? { contextScreenshot: record.contextScreenshot } : {}),
          ...(typeof record.timeoutSeconds === "number" ? { timeoutSeconds: record.timeoutSeconds } : {}),
          ...(typeof record.timeoutMs === "number" ? { timeoutMs: record.timeoutMs } : {}),
        };
        break;
      case "read_background_output":
        args = {
          ...(typeof record.pid === "number" ? { pid: record.pid } : {}),
          ...(typeof record.lines === "number" ? { lines: record.lines } : {}),
          ...(typeof record.waitForMatch === "string" ? { waitForMatch: record.waitForMatch } : {}),
          ...(typeof record.minWaitMs === "number" ? { minWaitMs: record.minWaitMs } : {}),
        };
        break;
      case "signal_process":
        args = {
          ...(typeof record.pid === "number" ? { pid: record.pid } : {}),
          ...(typeof record.signal === "string" ? { signal: record.signal } : {}),
        };
        break;
      case "write_to_process":
        args = {
          ...(typeof record.pid === "number" ? { pid: record.pid } : {}),
          ...(typeof record.input === "string" ? { input: record.input } : {}),
        };
        break;
      case "get_tool_output":
        args = {
          ...(typeof record.artifactId === "string" ? { artifactId: record.artifactId } : {}),
        };
        break;
      case "activate_skill":
        args = {
          ...(typeof record.name === "string" ? { name: record.name } : {}),
        };
        break;
      case "web_fetch":
        args = {
          ...(typeof record.url === "string" ? { url: record.url } : {}),
          ...(typeof record.extractText === "boolean" ? { extractText: record.extractText } : {}),
        };
        break;
      case "search_tools":
        args = {
          ...(typeof record.query === "string" ? { query: record.query } : {}),
        };
        break;
      case "scratchpad":
        args = {
          ...(typeof record.action === "string" ? { action: record.action } : {}),
          ...(typeof record.note === "string" ? { note: record.note } : {}),
          ...(typeof record.label === "string" ? { label: record.label } : {}),
        };
        break;
      case "search_memory":
        args = {
          ...(typeof record.query === "string" ? { query: record.query } : {}),
          ...(typeof record.max_hits === "number" ? { max_hits: record.max_hits } : {}),
          ...(typeof record.include_body === "boolean" ? { include_body: record.include_body } : {}),
          ...(typeof record.session_id === "string" ? { session_id: record.session_id } : {}),
          ...(typeof record.since === "string" ? { since: record.since } : {}),
        };
        break;
      default:
        // Preserve original args for tools without a dedicated normalizer
        // (skills, extensions, hooks, etc.). Only overlay path/cmd aliases
        // when present — never wipe the payload to those keys alone.
        args = {
          ...record,
          ...(normalizedWorkspacePath ? { path: normalizedWorkspacePath } : {}),
          ...(normalizedCmd ? { cmd: normalizedCmd } : {}),
        };
        break;
    }
  }

  return {
    id,
    name: normalizedName,
    args,
  };
}

function normalizeContainerWorkspacePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\\/g, "/");
  if (normalized === "/app") return ".";
  if (normalized.startsWith("/app/")) return normalized.slice("/app/".length);
  return value;
}


function normalizeToolName(rawName: string | undefined, _args: unknown): string | undefined {
  const canonical = rawName?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const aliases: Record<string, string> = {
    bash: "bash",
    browser: "browser_control",
    browser_use: "browser_control",
    browser_action: "browser_control",
    browser_control: "browser_control",
    computer: "computer_control",
    computer_use: "computer_control",
    computer_action: "computer_control",
    computer_control: "computer_control",
    mouse: "mouse_move",
    mouse_move: "mouse_move",
    move_mouse: "mouse_move",
    mouse_click: "mouse_click",
    click_mouse: "mouse_click",
    mouse_scroll: "mouse_scroll",
    scroll_mouse: "mouse_scroll",
    keyboard_type: "keyboard_type",
    type_keyboard: "keyboard_type",
    type_text: "keyboard_type",
    keyboard_press: "keyboard_press",
    press_key: "keyboard_press",
    screenshot: "screenshot",
    screen_capture: "screenshot",
    get_screen_size: "get_screen_size",
    screen_size: "get_screen_size",
    get_mouse_position: "get_mouse_position",
    mouse_position: "get_mouse_position",
    wait: "wait",
    start_live_view: "start_live_view",
    live_view: "start_live_view",
    stop_live_view: "stop_live_view",
    request_human_approval: "request_human_approval",
    human_approval: "request_human_approval",
    is_human_intervening: "is_human_intervening",
    read: "read_file",
    open_file: "read_file",
    view_file: "view_file",
    view: "view_file",
    list: "list_directory",
    ls: "list_directory",
    search: "grep_search",
    grep: "grep_search",
    write: "write_file",
    create_file: "write_file",
    write_to_file: "write_file",
    edit: "replace_in_file",
    edit_file: "replace_in_file",
    replace: "replace_in_file",
    delete: "delete_file",
  };
  if (canonical && aliases[canonical]) {
    return aliases[canonical];
  }
  return rawName;
}
