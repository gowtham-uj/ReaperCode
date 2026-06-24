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
  } else if (raw.toolArgs && typeof raw.toolArgs === "object") {
    args = raw.toolArgs;
  } else if (raw.toolArguments && typeof raw.toolArguments === "object") {
    args = raw.toolArguments;
  } else if (raw.parameters && typeof raw.parameters === "object") {
    args = raw.parameters;
  }

  const inferredName = normalizeToolName(rawName, args);
  let normalizedName = inferredName;
  if ((!args || typeof args !== "object") && inferredName === "sandbox_service_control") {
    args = {};
  }

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

    const normalizedCmd =
      typeof record.cmd === "string"
        ? record.cmd
        : typeof record.command === "string"
          ? record.command
          : typeof record.shellCommand === "string"
            ? record.shellCommand
            : typeof record.shell_command === "string"
              ? record.shell_command
              : undefined;

    const normalizedCwd =
      typeof record.cwd === "string"
        ? record.cwd
        : typeof record.working_directory === "string"
          ? record.working_directory
          : typeof record.workingDirectory === "string"
            ? record.workingDirectory
            : typeof record.workdir === "string"
              ? record.workdir
              : typeof record.directory === "string"
                ? record.directory
                : undefined;

    const normalizedStepId =
      typeof record.stepId === "string"
        ? record.stepId
        : typeof record.step_id === "string"
          ? record.step_id
          : undefined;

    let name = normalizeToolName(rawName, args);
    if (name === "run_shell_command" && shouldRouteShellCommandToSandboxService(id, raw, record, normalizedCmd)) {
      name = "sandbox_service_control";
    }
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
      case "replace_in_file":
        args = {
          ...(normalizedWorkspacePath ? { path: normalizedWorkspacePath } : {}),
          ...(normalizedOld !== undefined ? { oldString: normalizedOld } : {}),
          ...(normalizedNew !== undefined ? { newString: normalizedNew } : {}),
          ...(typeof record.allowMultiple === "boolean" ? { allowMultiple: record.allowMultiple } : {}),
        };
        break;
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
      case "run_shell_command":
        args = {
          ...(normalizedCmd ? { cmd: normalizedCmd } : {}),
          ...(normalizedCwd ? { cwd: normalizedCwd } : {}),
          ...(typeof record.timeoutMs === "number" ? { timeoutMs: record.timeoutMs } : {}),
          ...(typeof record.idleTimeoutMs === "number" ? { idleTimeoutMs: record.idleTimeoutMs } : {}),
          ...(typeof record.isBackground === "boolean" ? { isBackground: record.isBackground } : {}),
          ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
          ...(typeof record.barrier === "boolean" ? { barrier: record.barrier } : {}),
          ...(typeof record.forceNonBarrier === "boolean" ? { forceNonBarrier: record.forceNonBarrier } : {}),
        };
        break;
      case "sandbox_service_control": {
        const action = normalizeSandboxServiceAction(record, raw, id);
        const service =
          typeof record.service === "string"
            ? record.service
            : typeof record.serviceName === "string"
              ? record.serviceName
              : typeof record.service_name === "string"
                ? record.service_name
                : typeof record.container === "string"
                  ? record.container
                  : typeof record.containerName === "string"
                    ? record.containerName
                    : undefined;
        const sourcePath =
          typeof record.sourcePath === "string"
            ? record.sourcePath
            : typeof record.source_path === "string"
              ? record.source_path
              : typeof record.src === "string"
                ? record.src
                : undefined;
        const targetPath =
          typeof record.targetPath === "string"
            ? record.targetPath
            : typeof record.target_path === "string"
              ? record.target_path
              : typeof record.destination === "string"
                ? record.destination
                : typeof record.dest === "string"
                  ? record.dest
                  : ["write_file", "copy_to_service", "restore_from_image"].includes(action ?? "") && normalizedPath
                    ? normalizedPath
                    : undefined;
        args = {
          ...(action ? { action } : {}),
          ...(service ? { service } : {}),
          ...(normalizedCmd ? { command: normalizedCmd } : {}),
          ...(sourcePath ? { sourcePath } : {}),
          ...(targetPath ? { targetPath } : {}),
          ...(typeof record.content === "string" ? { content: record.content } : {}),
          ...(typeof record.tail === "number" ? { tail: record.tail } : {}),
          ...(typeof record.intervalMs === "number" ? { intervalMs: record.intervalMs } : {}),
          ...(typeof record.timeoutMs === "number" ? { timeoutMs: record.timeoutMs } : {}),
        };
        break;
      }
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
      case "complete_task":
        args = {
          ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
          ...(record.verificationContract && typeof record.verificationContract === "object" ? { verificationContract: record.verificationContract } : {}),
          ...(Array.isArray(record.objectives) ? { objectives: record.objectives } : {}),
        };
        break;
      case "advance_step":
        args = {
          ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
          ...(normalizedStepId ? { stepId: normalizedStepId } : {}),
          ...(Array.isArray(record.evidence) ? { evidence: record.evidence } : {}),
        };
        break;
      case "request_patch":
        args = {
          ...(typeof record.reasonPatchNeeded === "string"
            ? { reasonPatchNeeded: record.reasonPatchNeeded }
            : typeof record.summary === "string"
              ? { reasonPatchNeeded: record.summary }
              : {}),
          ...(record.blockedStep && typeof record.blockedStep === "object" ? { blockedStep: record.blockedStep } : {}),
          ...(record.evidence && typeof record.evidence === "object" ? { evidence: record.evidence } : {}),
          ...(Array.isArray(record.filesHint) ? { filesHint: record.filesHint } : {}),
          ...(Array.isArray(record.acceptanceCriteria) ? { acceptanceCriteria: record.acceptanceCriteria } : {}),
          ...(typeof record.resumeFromStepId === "string" ? { resumeFromStepId: record.resumeFromStepId } : {}),
        };
        break;
      case "delegate_to_plan":
        args = {
          ...(Array.isArray(record.plan) ? { plan: record.plan } : {}),
        };
        break;
      case "web_fetch":
        args = {
          ...(typeof record.url === "string" ? { url: record.url } : {}),
          ...(typeof record.extractText === "boolean" ? { extractText: record.extractText } : {}),
        };
        break;
      case "task_create":
        args = {
          ...(typeof record.subject === "string" ? { subject: record.subject } : {}),
          ...(typeof record.description === "string" ? { description: record.description } : {}),
          ...(typeof record.status === "string" ? { status: record.status } : {}),
        };
        break;
      case "task_update":
        args = {
          ...(typeof record.taskId === "string" ? { taskId: record.taskId } : {}),
          ...(typeof record.status === "string" ? { status: record.status } : {}),
          ...(typeof record.subject === "string" ? { subject: record.subject } : {}),
          ...(typeof record.description === "string" ? { description: record.description } : {}),
        };
        break;
      case "task_list":
        args = {
          ...(typeof record.status === "string" ? { status: record.status } : {}),
        };
        break;
      case "search_tools":
        args = {
          ...(typeof record.query === "string" ? { query: record.query } : {}),
        };
        break;
      case "call_subagent":
        args = {
          ...(typeof record.type === "string" ? { type: record.type } : {}),
          ...(typeof record.task === "string" ? { task: record.task } : {}),
          ...(typeof record.context === "string" ? { context: record.context } : {}),
          ...(typeof record.mode === "string" ? { mode: record.mode } : {}),
          ...(Array.isArray(record.allowedFiles) ? { allowedFiles: record.allowedFiles } : {}),
          ...(Array.isArray(record.forbiddenFiles) ? { forbiddenFiles: record.forbiddenFiles } : {}),
          ...(typeof record.timeoutMs === "number" ? { timeoutMs: record.timeoutMs } : {}),
          ...(typeof record.outputSchema === "string" ? { outputSchema: record.outputSchema } : {}),
        };
        break;
      default:
        args = {
          ...(normalizedWorkspacePath ? { path: normalizedWorkspacePath } : {}),
          ...(normalizedCmd ? { cmd: normalizedCmd } : {}),
          ...(normalizedCwd ? { cwd: normalizedCwd } : {}),
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

function normalizeSandboxServiceAction(record: Record<string, unknown>, raw: Record<string, unknown>, id: string): string | undefined {
  const explicit =
    typeof record.action === "string"
      ? record.action
      : typeof record.operation === "string"
        ? record.operation
        : typeof record.op === "string"
          ? record.op
          : undefined;
  const normalizedExplicit = normalizeSandboxServiceActionToken(explicit);
  if (normalizedExplicit) return normalizedExplicit;

  const hint = [id, raw.name, raw.toolName, raw.tool_name, raw.tool, record.intent, record.summary, record.description]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase()
    .replace(/[_-]+/g, " ");

  if (/\b(?:wait ready|wait_ready|readiness|ready|health)\b/.test(hint)) return "wait_ready";
  if (typeof record.command === "string" || typeof record.cmd === "string" || typeof record.shellCommand === "string" || typeof record.shell_command === "string") {
    return "exec";
  }
  if (typeof record.content === "string") return "write_file";
  if (
    typeof record.sourcePath === "string" ||
    typeof record.source_path === "string" ||
    typeof record.src === "string"
  ) {
    return "copy_to_service";
  }
  if (/\b(?:log|logs|tail)\b/.test(hint)) return "logs";
  if (/\b(?:inspect image|image inspect|underlying image)\b/.test(hint)) return "inspect_image";
  if (/\b(?:restore from image|restore image|image restore)\b/.test(hint)) return "restore_from_image";
  if (/\b(?:snap|snapshot|inspect|inventory)\b/.test(hint)) return "snapshot";
  if (/\b(?:list|services|service list|ps)\b/.test(hint)) return "list";
  if (/\brestart\b/.test(hint)) return "restart";
  if (/\brecreate\b/.test(hint)) return "recreate";
  if (/\bstart\b/.test(hint)) return "start";
  if (/\bstop\b/.test(hint)) return "stop";
  if (/\b(?:copy|cp)\b/.test(hint)) return "copy_to_service";
  if (/\b(?:write|create)\b/.test(hint)) return "write_file";
  if (/\b(?:exec|run|shell|command)\b/.test(hint)) return "exec";
  return undefined;
}

function shouldRouteShellCommandToSandboxService(
  id: string,
  raw: Record<string, unknown>,
  record: Record<string, unknown>,
  command: string | undefined,
): boolean {
  if (!command?.trim()) return false;
  const hint = [id, raw.name, raw.toolName, raw.tool_name, raw.tool, record.intent, record.summary, record.description]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase()
    .replace(/[_-]+/g, " ");
  if (!/\b(?:svc|service|sandbox service|sidecar|sibling container)\b/.test(hint)) return false;
  if (/\bdocker(?:\s+compose)?\b/i.test(command)) return false;
  return true;
}

function normalizeSandboxServiceActionToken(value: string | undefined): string | undefined {
  const token = value?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!token) return undefined;
  const aliases: Record<string, string> = {
    list: "list",
    services: "list",
    ps: "list",
    logs: "logs",
    log: "logs",
    tail: "logs",
    snapshot: "snapshot",
    snap: "snapshot",
    inspect: "snapshot",
    inventory: "snapshot",
    inspect_image: "inspect_image",
    image_inspect: "inspect_image",
    restore_from_image: "restore_from_image",
    image_restore: "restore_from_image",
    exec: "exec",
    run: "exec",
    shell: "exec",
    command: "exec",
    write: "write_file",
    write_file: "write_file",
    create: "write_file",
    copy: "copy_to_service",
    cp: "copy_to_service",
    copy_to_service: "copy_to_service",
    restart: "restart",
    recreate: "recreate",
    start: "start",
    stop: "stop",
    ready: "wait_ready",
    readiness: "wait_ready",
    health: "wait_ready",
    wait_ready: "wait_ready",
  };
  return aliases[token];
}

function normalizeToolName(rawName: string | undefined, args: unknown): string | undefined {
  const canonical = rawName?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const aliases: Record<string, string> = {
    bash: "run_shell_command",
    shell: "run_shell_command",
    run_command: "run_shell_command",
    execute_command: "run_shell_command",
    shell_command: "run_shell_command",
    terminal: "run_shell_command",
    sandbox_service: "sandbox_service_control",
    sandbox_services: "sandbox_service_control",
    sandbox_service_control: "sandbox_service_control",
    service_control: "sandbox_service_control",
    container_service_control: "sandbox_service_control",
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
    edit_file: "replace_in_file",
    replace: "replace_in_file",
    delete: "delete_file",
    finish: "complete_task",
    complete: "complete_task",
  };
  if (canonical && aliases[canonical]) {
    return aliases[canonical];
  }
  if (canonical && args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    if (typeof record.cmd === "string" || typeof record.command === "string" || typeof record.shellCommand === "string" || typeof record.shell_command === "string") {
      return "run_shell_command";
    }
    if (typeof record.path === "string" && typeof record.content === "string") {
      return "write_file";
    }
  }
  return rawName;
}
