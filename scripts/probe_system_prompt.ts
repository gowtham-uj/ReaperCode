import { getSystemPromptPrefix, buildSystemPromptForRole } from "/workspace/src/runtime/prompt-builders.js";

console.log("System prefix length:", getSystemPromptPrefix().length);
console.log("System planner length:", buildSystemPromptForRole("planner").length);
console.log("System executor length:", buildSystemPromptForRole("executor").length);
console.log("System patcher length:", buildSystemPromptForRole("patcher").length);
console.log("System recovery length:", buildSystemPromptForRole("recovery").length);
// check stability
const a = buildSystemPromptForRole("planner");
const b = buildSystemPromptForRole("planner");
console.log("Stable across calls:", a === b);