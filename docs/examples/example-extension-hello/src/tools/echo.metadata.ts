/**
 * ToolMetadata for hello.echo. The install pipeline reads this file
 * and registers the metadata on the ExtensionToolRegistry so the
 * policy gate sees it on first call.
 */
import type { ToolMetadata } from "reaper";

export const ECHO_METADATA: ToolMetadata = {
  name: "hello.echo",
  category: "read",
  risk_level: "low",
  is_read_only: true,
  can_modify_files: false,
  can_execute_code: false,
  can_control_ui: false,
  can_affect_host: false,
  requires_approval: false,
  preferred_before: [],
  preferred_after: [],
  forbidden_in_roles: [],
  allowed_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"],
};
