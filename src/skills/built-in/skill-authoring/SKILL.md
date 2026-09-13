# Writing a skill

A skill is a document the model loads on demand. It is not code, it does not
grant tools, and nothing enforces it. That is the whole design, and it tells you
what a good one looks like: if a skill cannot change what you do next, it is
prose.

There is one tool for this, `skill_manager`, with five actions. `create` is the
only one that matters for authoring.

## Decide first whether to write one

Write a skill when the same knowledge is needed at the same moments across
different tasks, and the model does not already have it. A debugging procedure
for a specific stack, the conventions of a specific repo, a workflow the user
repeats.

Do not write one when:

- The knowledge is a fact about this conversation. That is a scratchpad note.
- The knowledge is a rule the model should always follow. That is a hook, or a
  line in the project's `AGENTS.md`.
- The knowledge is one command. Write it in the answer.
- The knowledge is already in the model. Restating general programming advice
  in a skill wastes the context it costs and teaches nothing.

The test: after loading this skill, would the model do something *different*?
If not, the skill is a summary, and summaries are what the conversation already
contains.

## `skill_manager` create

One call, with the full definition. There is no draft state and no separate
approval step: a skill you create is usable immediately, and `approve` exists
only so a caller written against the older workflow still works.

```
skill_manager({
  action: "create",
  name: "python-pytest-runner",
  version: "1.0.0",
  description: "Run pytest and read the failures.",
  category: "python-debugging",
  when_to_use: "When the user asks to run tests in a Python project.",
  body: "# Running pytest\n\n...",
  triggers: ["pytest", "run the tests"],
  scope: "user"
})
```

### The fields that decide whether it works

`name` is kebab-case, `^[a-z][a-z0-9-]{0,63}$`. It is also the directory name,
and creating a name that already exists is refused rather than overwritten.

`category` is a closed list. An invalid one is rejected, so use a real value:
`repo-understanding`, `bug-fixing`, `test-failure-debugging`,
`typescript-refactor`, `python-debugging`, `frontend-react-debugging`,
`api-backend-debugging`, `security-review`, `performance-review`,
`documentation-writing`, `terminal-bench-solving`, `swe-bench-solving`,
`agent-runtime-debugging`, `session-persistence`, `prompt-enhancement`.

`when_to_use` and `triggers` are what the router matches on. This is the field
people get wrong most often, because it feels like documentation. It is not: it
is the retrieval key. Write it as the situation, not the topic.

- Weak: `"pytest"` — matches every mention of the word, including "don't use
  pytest".
- Strong: `"When a Python test run fails and the user wants the failing test
  understood, not just re-run."`

`description` is one line and the router reads it verbatim. It should say what
the skill does, not how good it is. "Run pytest and read the failures" beats
"A comprehensive guide to pytest failure analysis."

`body` is the document, and it is the part that matters. See below.

## What to put in the body

Lead with the decision, not the background. A model loading a skill already
knows why it is there; it needs to know what to do.

Prefer concrete over general. A command that runs, a file that exists, an error
message that is real. "Check the logs" teaches nothing; `pytest -x --tb=short`
and the shape of its output teaches something.

Say when not to use it. A skill that claims to apply everywhere gets loaded
everywhere and read nowhere. The negative case is often the most useful line in
the document.

Keep it short. Every token here costs context in the turn that loads it, and a
skill is competing with the actual task. If it needs more than a page or two,
it is probably two skills.

Show the worked case. One example that runs end to end is worth more than a
section of rules, because the model generalizes from it directly.

## Verify before you finish

`test` runs the skill's `validation.commands` if it has any, in order, and stops
at the first non-zero exit. Those commands are shell lines, run for real.

```
skill_manager({ action: "test", name: "python-pytest-runner" })
```

If you wrote a skill whose body claims a command works, put that command in
`validation_commands` and let `test` prove it. A skill that documents a command
nobody ran is a guess with a filename.

Then read it back the way the model will see it: `activate_skill` with the name
returns the body wrapped in `<activated_skill>` tags, which is exactly what the
next turn gets. If it reads badly there, it reads badly in use.

## What a skill cannot do

- It cannot grant a tool. `allowed_tools` describes what the skill is *about*.
  The executor never reads a skill manifest — capability comes from the core
  tool set, the role profile, the thread's disabled-tools list, and the sandbox
  policy.
- It cannot make the model follow it. There is no enforcement. If something must
  happen every time, that is a hook.
- It cannot be partially loaded. The whole body arrives or none of it does,
  which is the other reason to keep it short.

## Removing one

`skill_manager({ action: "uninstall", name, scope })`. Ungated, and it removes
the directory as well as the registry entry. Creating without removing would be
a one-way door, so this is the way back.
