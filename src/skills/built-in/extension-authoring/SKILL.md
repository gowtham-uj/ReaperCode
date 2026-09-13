# Writing an extension

An extension is JavaScript that runs at load time and registers things: tools,
hooks, slash commands, skills, context providers. It is the way to add a
capability the tool set does not have, as opposed to a skill, which is a
document that changes how the model approaches work it can already do.

Extensions are JavaScript only. There is no build step and no TypeScript.

## Decide first whether to write one

Write an extension when the capability is a *tool*: something with arguments,
called by name, whose result the model reasons about. It should be something
used across many tasks, not once.

Do not write one when:

- A skill would do. If the answer is "here is how to do this with the tools you
  have", that is a skill document and it costs nothing to load.
- The capability is one shell command. `bash` exists.
- The work is programmatic glue over existing tools. `eval` exists, and it can
  already call every tool without any registration.
- Nothing will call it twice. An extension is a commitment to maintain.

## `extension_manager` create

```
extension_manager({
  action: "create",
  id: "json-tools",
  version: "1.0.0",
  description: "Validate and query JSON files.",
  source: "...",         // the main.js contents
  permissions: [],
  scope: "user"
})
```

`id` is kebab-case and is also the install directory. Reusing an existing id is
refused rather than overwritten.

## The part that decides whether it works

An extension is a module whose default export has an `activate` function:

```js
module.exports = {
  activate(ctx) {
    ctx.registerTool({
      name: "json_validate",
      description: "Validate a JSON file and report the first error.",
      metadata: {
        name: "json_validate",
        category: "read",
        risk_level: "low",
        is_read_only: true,
        can_modify_files: false,
        can_execute_code: false,
        can_control_ui: false,
        can_affect_host: false,
        requires_approval: false,
      },
      handler: async (args) => {
        const fs = require("node:fs");
        try {
          JSON.parse(fs.readFileSync(String(args.path), "utf8"));
          return { ok: true };
        } catch (error) {
          return { ok: false, error: error.message };
        }
      },
    });
  },
};
```

Two things in there are load-bearing.

**`activate` has to be reachable, and almost any spelling is.** The loader
checks `default`, the module namespace, and `default.default` in turn, so all of
these resolve:

```js
module.exports = { activate };            // CommonJS object
exports.activate = activate;              // CommonJS named
module.exports = activate;                // a bare function
export default { activate };              // ESM default object
export function activate(ctx) {}          // ESM named export
export default function activate(ctx) {}  // ESM default function
```

What does not resolve is a module with no `activate` anywhere, or one where
`activate` is not a function. If your extension loads and does nothing, the
cause is one of those, not the export syntax.

**`metadata.name` must equal `name`.** This is the trap. If they disagree the
registration is dropped — not renamed, not defaulted, dropped — and nothing in
the `create` result says so. The tool is simply absent afterwards, and the error
you get is "unknown tool". Write both fields from the same string, or check
`extension_manager list` for the `refused` list after creating.

`metadata` is required in full. The policy gate reads it on every call and
denies a tool without it.

## Permissions

`permissions` declares what the extension may use. An empty list means it can
register tools and read its own install path, and nothing more. The values are
`tools:read`, `tools:write_file`, `tools:edit_file`, `tools:delete_file`,
`tools:bash`, `tools:network`, `shell:low`, `shell:medium`, `shell:high`,
`memory:project:read`, `memory:project:write`, `memory:user:read`,
`memory:user:write`.

Ask for what you use. A permission you do not need is a prompt the user has to
read and a thing that can go wrong later.

## Hooks and commands

`ctx.registerHook({ event, handler, timeoutMs })` subscribes to a lifecycle
event. The handler returns `{ allow, message?, reason? }`. `PreToolUse` with
`allow: false` blocks the call, so only do that when blocking is the point.
Events include `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop`,
`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PreSkillInvoke`,
`PostSkillInvoke`, `SkillCreated`, `SkillSelected`, `PreCompact`, `PostCompact`,
`FileChanged`, and the memory events.

`ctx.registerSlashCommand({ name, description, handler })` adds a `/name` the
user can type.

## Verify before you finish

```
extension_manager({ action: "validate", id: "json-tools" })
```

Then the step people skip:

```
extension_manager({ action: "enable", id: "json-tools" })
```

`create` writes the files and `enable` runs `activate`. A create that succeeded
tells you the manifest parsed; it tells you nothing about whether `activate`
threw or whether a tool was refused. Enable, then check the tool is real:

```
search_tools({ query: "json" })
```

If it is missing, the two causes are the metadata trap above and a throw inside
`activate`. `extension_manager list` reports `refused` registrations with the
reason, which is the fastest way to tell them apart.

Then call the tool once with a real argument. Registration is not execution, and
the handler is where the actual bugs are.

## Removing one

`extension_manager({ action: "uninstall", id })`. It removes the registry entry
and the install directory. Disable first if you only want it off for now.
