/**
 * Shell command parsing helpers.
 *
 * Pure functions extracted from runtime/engine.ts to keep the engine
 * smaller. All helpers operate on a single shell command string and
 * return either a parsed value or a boolean predicate.
 */

import { isBuildCommand, isTestCommand, isVerificationLikeCommand } from "./relevance-gate.js";

export function isExplicitBuildTestOrCheckCommand(command: string): boolean {
  return (
    isBuildCommand(command) ||
    isTestCommand(command) ||
    /\b(?:tsc|eslint|ruff|mypy|go\s+test|go\s+vet|cargo\s+(?:test|check|clippy)|mvn\s+test|gradle\s+test|playwright|cypress|smoke|python3?\s+-m\s+pytest|python3?\s+-m\s+unittest)\b/i.test(
      command,
    )
  );
}

export function isCheckLikeShellCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  return (
    isExplicitBuildTestOrCheckCommand(normalized) ||
    isVerificationLikeCommand(normalized) ||
    isBuildArtifactRuntimeCommand(normalized) ||
    /(?:^|[;&|]\s*|\b&&\s*)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:check|verify|validate|lint|typecheck|smoke)\b/i.test(normalized) ||
    /(?:^|[;&|]\s*|\b&&\s*)(?:check|verify|validate|lint|typecheck|doctor|smoke|ctest|unittest)\b/i.test(normalized) ||
    /(?:^|[;&|]\s*|\b&&\s*)(?:cat|head|tail|wc|stat|test|ls)\b/i.test(normalized)
  );
}

export function shouldBlockVerifierOwnedShellMutation(command: string): boolean {
  const normalized = command.replace(/\\\n/g, " ").replace(/\s+/g, " ");
  return (
    /(?:^|[;&|]\s*)(?:rm|rmdir|mv|cp|install|touch|mkdir|chmod|chown|truncate)\b[^;&|]*\s\/(?:tests?|__tests__)(?:\/|\s|$)/i.test(normalized) ||
    /(?:^|[;&|]\s*)sed\b[^;&|]*\s-i\b[^;&|]*\s\/(?:tests?|__tests__)(?:\/|\s|$)/i.test(normalized) ||
    /(?:>|>>)\s*\/(?:tests?|__tests__)(?:\/|$)/i.test(normalized) ||
    /\btee\s+(?:-[A-Za-z]+\s+)*\/(?:tests?|__tests__)(?:\/|\s|$)/i.test(normalized)
  );
}

export function hasShellWriteToLikelyPath(command: string, isTargetPath: (target: string) => boolean): boolean {
  return splitUnquotedShellSegments(command).some(
    (segment) =>
      (hasUnquotedCommandWord(segment, ["cat", "printf", "echo"]) && hasUnquotedRedirectToLikelyPath(segment, isTargetPath)) ||
      hasUnquotedTeeToLikelyPath(segment, isTargetPath),
  );
}

export function hasSourceMutationShellFragment(command: string): boolean {
  const sourcePath = String.raw`[^;&|]*\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|ts|tsx|js|jsx|py|go|rs|java|kt|cs|rb|php|swift|m|mm|scala|sh|json|toml|ya?ml|xml|cmake|txt)|[^;&|]*(?:CMakeLists\.txt|Makefile|package\.json|pyproject\.toml|Cargo\.toml|go\.mod)`;
  const unquoted = stripQuotedShellText(command);
  const shellWrite = new RegExp(String.raw`\b(?:sed|perl|python|python3|ruby|node|awk)\b[^;&|]*(?:-i|write|replace|truncate|rename)[^;&|]*(?:${sourcePath})`, "i");
  return shellWrite.test(unquoted) || hasShellWriteToLikelyPath(command, isBroadSourceWriteTarget);
}

export function hasVerificationShellFragment(command: string): boolean {
  return /\b(?:cmake|make|gmake|ninja|npm\s+(?:test|run\s+(?:test|build|lint|check))|pnpm\s+(?:test|run\s+(?:test|build|lint|check))|yarn\s+(?:test|run\s+(?:test|build|lint|check))|bun\s+(?:test|run\s+(?:test|build|lint|check))|pytest|python\s+-m\s+pytest|cargo\s+(?:test|build|check)|go\s+test|mvn\s+test|gradle\s+test|ctest)\b/.test(command);
}

export function isBroadSourceWriteTarget(target: string): boolean {
  return isLikelyShellPath(
    target,
    /(?:^|\/)[^;&|]+\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|ts|tsx|js|jsx|py|go|rs|java|kt|cs|rb|php|swift|m|mm|scala|sh|json|toml|ya?ml|xml|cmake|txt)$/i,
  ) || /(?:^|\/)(?:CMakeLists\.txt|Makefile|package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/i.test(cleanShellWord(target));
}

export function isLikelyShellPath(target: string, pattern: RegExp): boolean {
  const clean = cleanShellWord(target);
  if (!clean || clean.startsWith("-") || clean.startsWith("&")) return false;
  if (/^[A-Za-z]+:\/\//.test(clean)) return false;
  return pattern.test(clean);
}

export function cleanShellWord(value: string): string {
  return value.trim().replace(/^['"`]+|['"`]+$/g, "");
}

export function hasUnquotedCommandWord(segment: string, commands: string[]): boolean {
  const visible = stripQuotedShellText(segment);
  return commands.some((command) => new RegExp(String.raw`(?:^|[\s({])${escapeRegExp(command)}(?:$|[\s)}])`, "i").test(visible));
}

export function hasUnquotedRedirectToLikelyPath(segment: string, isTargetPath: (target: string) => boolean): boolean {
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index] ?? "";
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\" && quote !== "'") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char !== ">") continue;
    const previous = segment[index - 1] ?? "";
    const next = segment[index + 1] ?? "";
    if (previous === "-" || previous === "=" || previous === "<" || previous === ">" || next === "=") continue;
    const operatorLength = next === ">" ? 2 : 1;
    const target = readShellWord(segment, index + operatorLength);
    if (isTargetPath(target)) return true;
  }
  return false;
}

export function hasUnquotedTeeToLikelyPath(segment: string, isTargetPath: (target: string) => boolean): boolean {
  const words = parseShellWords(segment);
  for (let index = 0; index < words.length; index += 1) {
    if (words[index]?.toLowerCase() !== "tee") continue;
    for (let targetIndex = index + 1; targetIndex < words.length; targetIndex += 1) {
      const target = words[targetIndex] ?? "";
      if (target.startsWith("-")) continue;
      if (isTargetPath(target)) return true;
      break;
    }
  }
  return false;
}

export function splitUnquotedShellSegments(command: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\" && quote !== "'") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "\n" || char === ";" || char === "|" || (char === "&" && command[index + 1] === "&")) {
      const segment = command.slice(start, index).trim();
      if (segment) segments.push(segment);
      if ((char === "&" && command[index + 1] === "&") || (char === "|" && command[index + 1] === "|")) index += 1;
      start = index + 1;
    }
  }
  const finalSegment = command.slice(start).trim();
  if (finalSegment) segments.push(finalSegment);
  return segments;
}

export function stripQuotedShellText(command: string): string {
  let output = "";
  let quote: string | null = null;
  let escaped = false;
  for (const char of command) {
    if (quote) {
      output += char === "\n" ? "\n" : " ";
      if (escaped) {
        escaped = false;
      } else if (char === "\\" && quote !== "'") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      output += " ";
      continue;
    }
    output += char;
  }
  return output;
}

export function readShellWord(input: string, start: number): string {
  let index = start;
  while (index < input.length && /\s/.test(input[index] ?? "")) index += 1;
  let word = "";
  let quote: string | null = null;
  let escaped = false;
  for (; index < input.length; index += 1) {
    const char = input[index] ?? "";
    if (quote) {
      if (escaped) {
        word += char;
        escaped = false;
      } else if (char === "\\" && quote !== "'") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      } else {
        word += char;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (/\s/.test(char) || /[;&|<>()]/.test(char)) break;
    word += char;
  }
  return word;
}

export function parseShellWords(input: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: string | null = null;
  let escaped = false;
  const pushWord = () => {
    if (word) words.push(word);
    word = "";
  };
  for (const char of input) {
    if (quote) {
      if (escaped) {
        word += char;
        escaped = false;
      } else if (char === "\\" && quote !== "'") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      } else {
        word += char;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (/\s/.test(char) || /[;&|<>()]/.test(char)) {
      pushWord();
      continue;
    }
    word += char;
  }
  pushWord();
  return words;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isBuildArtifactRuntimeCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (isBuildCommand(normalized)) return false;
  if (/(?:^|[;&|]\s*|\bdo\s+)(?:\.\/|build\/|\.\/build\/|dist\/|target\/|bin\/)[A-Za-z0-9_./-]+/.test(normalized)) return true;
  return /\b(?:xargs|parallel|find)\b.*(?:\.\/|build\/|\.\/build\/|dist\/|target\/|bin\/)[A-Za-z0-9_./-]+/.test(normalized);
}
