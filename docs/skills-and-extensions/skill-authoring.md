# Skill Authoring

A skill is a folder containing `skill.json` and `SKILL.md`, plus
optional `examples/`, `templates/`, `tests/`, and `resources/`
subdirectories. The router reads only `skill.json`; the body is read
on demand by `activate_skill`.

## Folder layout

```
my-skill/
  skill.json            # required — manifest
  SKILL.md              # required — body (markdown)
  examples/             # optional — concrete worked examples
  templates/            # optional — fill-in-the-blank templates
  tests/                # optional — small validation scripts
  resources/            # optional — static assets
```

## `skill.json` schema

```json
{
  "name": "json-yaml",
  "version": "1.0.0",
  "description": "Convert between JSON and YAML.",
  "category": "documentation-writing",
  "whenToUse": "user asks to translate JSON to YAML or vice versa",
  "triggers": ["json", "yaml", "convert"],
  "pathPatterns": ["**/*.json", "**/*.yaml", "**/*.yml"],
  "allowedTools": ["read_file", "write_file", "edit_file"],
  "arguments": [
    { "name": "direction", "description": "json-to-yaml or yaml-to-json", "required": true }
  ],
  "examples": ["examples/before.json", "examples/after.yaml"],
  "templates": ["templates/skeleton.json"],
  "validation": {
    "commands": [
      { "id": "load-example", "command": "node -e \"require('./examples/after.yaml')\"" }
    ]
  },
  "memoryPolicy": {
    "mayReadProjectMemory": true,
    "mayWriteProjectMemory": false,
    "mayReadUserMemory": false,
    "mayWriteUserMemory": false
  },
  "trust": "user-trusted",
  "author": "you",
  "license": "Apache-2.0",
  "minimumReaperVersion": "1.0.0"
}
```

### Required fields

| Field | Type | Notes |
|---|---|---|
| `name` | string | `^[a-z][a-z0-9-]{0,63}$` |
| `version` | string | semver |
| `description` | string | one-line summary used by the router |
| `category` | string | one of the 17 built-in categories |
| `whenToUse` | string | free text, surfaced in router output |
| `allowedTools` | string[] | tool names the model can call while this skill is active |
| `trust` | string | declared trust tier; resolved at install by `TrustResolver` |

### Optional fields

| Field | Type | Notes |
|---|---|---|
| `triggers` | string[] | keyword matches against the prompt (+3 per match) |
| `pathPatterns` | string[] | globs for `activateConditionalSkillsForPaths` (+4 per match) |
| `arguments` | array | argument spec for the skill |
| `examples` | string[] | paths relative to the skill root |
| `templates` | string[] | paths relative to the skill root |
| `tests` | string[] | paths relative to the skill root |
| `resources` | string[] | paths relative to the skill root |
| `validation` | object | commands to run during `reaper skill test` |
| `memoryPolicy` | object | what memory scopes the skill can read/write |
| `author` | string | informational |
| `license` | string | SPDX identifier |
| `minimumReaperVersion` | string | semver range |

## `SKILL.md` body

Write the imperative steps. Use `$ARGUMENTS` for argument values and
`${REAPER_SKILL_DIR}` for the skill's install path. Keep it focused —
5–20 lines is the sweet spot. Always end with a "When NOT to use"
section so the router can demote the skill on bad fits.

```markdown
# JSON ↔ YAML

1. Read the input file with `read_file`.
2. If `$ARGUMENTS.direction == "json-to-yaml"`, run `python3 -c "import json, sys, yaml; print(yaml.dump(json.load(open('$ARGUMENTS.path'))))"`.
3. If `yaml-to-json`, run `python3 -c "import json, sys, yaml; print(json.dumps(yaml.safe_load(open('$ARGUMENTS.path'))))"`.

## When NOT to use
- CSV / TSV / TOML — wrong format. Use the `csv` skill (when added).
- Binary formats.

## Validation
Run `node -e "require('./examples/after.yaml')"` to confirm the
example parses. (Configured in `skill.json`.)
```

## Drafts and trust promotion

1. `reaper skill create my-skill` — creates
   `~/.reaper/skills/drafts/my-skill/` with `trust: "draft"`. The
   skill is **not** invokable through `activate_skill` while it is a
   draft.
2. `reaper skill test my-skill` — runs `validation.commands` and
   updates `lastValidatedAt`.
3. `reaper skill trust my-skill` — moves the skill from `drafts/`
   to the user root and sets `trust: "user-trusted"`. Refuses on a
   draft that has not passed `test`.

## Variables in body

| Variable | Meaning |
|---|---|
| `$ARGUMENTS` | the full argument string after `/skill-name` |
| `${REAPER_SKILL_DIR}` | absolute path of the skill install dir |
| `${REAPER_WORKSPACE}` | absolute path of the active workspace |

## Validation commands

`validation.commands` is a list of `{id, command}` entries. Each
runs through the policy-gated shell path (so `shellQuote` is
applied). A non-zero exit code fails the test. Use `id` to identify
failures in `reaper skill test` output.
