export interface PatcherIntegrityInput {
  status: string;
  filesChanged: string[];
  behaviorChanged: string[];
  testsRun: Array<{ command: string; result: string }>;
  tool_calls: Array<{ name: string; args?: Record<string, unknown> }>;
}

export function enforcePatcherStatusIntegrity<T extends PatcherIntegrityInput>(result: T): T {
  if (result.status !== "patched_and_verified") return result;
  const hasMutation =
    result.filesChanged.length > 0 ||
    result.tool_calls.some((call) =>
      ["write_file", "replace_in_file", "edit_file", "replace_symbol", "delete_file"].includes(call.name) ||
      (call.name === "sandbox_service_control" &&
        ["restore_from_image", "write_file", "copy_to_service"].includes(String(call.args?.action ?? ""))),
    );
  const hasBehavioralVerification =
    result.testsRun.some((test) => test.result === "passed" && isBehavioralVerificationCommand(test.command)) ||
    result.tool_calls.some(
      (call) => call.name === "bash" && isBehavioralVerificationCommand(String(call.args?.cmd ?? "")),
    );
  if (hasMutation && hasBehavioralVerification) return result;
  return {
    ...result,
    status: "patch_in_progress",
    behaviorChanged: [
      ...result.behaviorChanged,
      "Status downgraded by Reaper: patched_and_verified lacked both concrete mutation evidence and a behavior-exercising verification.",
    ],
  };
}

export function isBehavioralVerificationCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (/^(?:cd\s+\S+\s+&&\s+)?(?:ls|find|cat|head|tail|sed\s+-n|grep|rg|stat|file|wc)\b/i.test(normalized)) return false;
  return /\b(?:test|pytest|ctest|go\s+test|cargo\s+test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test|node\s+--test|assert|curl|wget|diff|cmp|jq\s+-e|grep\s+-q|build|compile|typecheck|lint)\b/i.test(
    normalized,
  );
}
