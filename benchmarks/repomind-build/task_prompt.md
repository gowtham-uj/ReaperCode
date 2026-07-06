# Context Engineering Stress Test: Build RepoMind From Scratch

## Objective

You are inside a completely fresh repository.

Your goal is to build **RepoMind**, a repository intelligence platform that indexes source code, understands repository structure, retrieves only relevant context, answers repository questions, and performs coding tasks.

This task is intentionally designed to **stress test context engineering**, not just coding ability.

The harness will be evaluated on its ability to:

• Read hundreds of files efficiently
• Avoid unnecessary rereads
• Compress context into reusable summaries
• Preserve architectural understanding
• Retrieve only relevant information
• Maintain long-running state
• Execute tasks without losing context
• Verify its own work

---

# Product

Build a tool called **RepoMind**.

It should consist of:

• CLI
• Local SQLite database
• Repository indexer
• Context retrieval engine
• Local FastAPI dashboard
• Large repository fixture generator

---

# CLI Commands

Implement:

```bash
repomind index <path>
repomind ask "question"
repomind task "coding task"
repomind serve
```

---

# Repository Scanner

The scanner must:

• recursively scan repositories
• ignore: .git, node_modules, dist, build, .venv, __pycache__
Support extensions: .py .ts .tsx .js .jsx .md .json .yaml .yml

For every file:

• compute SHA256 hash
• estimate token count
• detect language
• extract symbols
• detect imports
• detect exports
• detect markdown headings
• create compact summary
• split into semantic chunks

Store everything inside SQLite.

---

# SQLite Schema

Tables: files, chunks, summaries, symbols, imports, tasks, retrieval history, context reports, repository metadata.

---

# Context Engineering Layer

Retrieval engine must:

• build a repository map
• build dependency graph
• create summaries
• estimate token usage
• rank relevance
• select context under token budget
• explain why files were selected

Every retrieval must generate `context_report.json` with shape:

```json
{
  "question": "...",
  "token_budget": 12000,
  "files_considered": 143,
  "files_selected": 11,
  "chunks_selected": 29,
  "estimated_tokens": 9612,
  "selection_reason": {
    "scanner.py": "contains indexing pipeline",
    "db.py": "stores summaries",
    "retriever.py": "implements ranking"
  }
}
```

---

# Web Dashboard

FastAPI app. Pages: /, /files, /summary, /context, /graph, /ask.

---

# Repository Fixture Generator

`fixtures/generate_large_repo.py` must produce at least:

• 120 Python files
• 40 TypeScript files
• 20 Markdown docs
• nested packages
• repeated filenames
• circular imports
• utility modules
• configuration files
• TODO comments
• hidden implementation notes
• intentionally confusing dead code

---

# Hidden Requirements

Scatter hidden requirements inside `docs/architecture/context.md`, `docs/product/spec.md`, `docs/backend/indexing.md`. Examples:

• scanner must support incremental indexing
• retrieval must prefer summaries over raw files
• dashboard should cache graph results
• task execution must write audit logs

---

# Project Structure

```
repomind/
  __init__.py
  cli.py
  config.py
  db.py
  scanner.py
  parser.py
  summarizer.py
  retriever.py
  context_budget.py
  task_runner.py
  models.py
  web.py
  utils.py

tests/
  test_scanner.py
  test_indexing.py
  test_retriever.py
  test_context_budget.py
  test_fixture_repo.py

fixtures/
  generate_large_repo.py

artifacts/
README.md
pyproject.toml
```

---

# Required Workflow

Before writing code create `artifacts/initial_repo_assessment.md`:

• repository observations
• implementation strategy
• architectural risks
• reading order
• expected bottlenecks
• context plan

During development append to `artifacts/context_log.md` for every major step:

• files read
• why they were read
• what information was extracted
• reusable summary
• files intentionally skipped
• updated architectural understanding

After completion generate `artifacts/final_context_report.md`:

• total files scanned
• total files read
• total files modified
• files reread
• avoided rereads
• retrieval efficiency
• architectural summary
• remaining limitations

---

# Functional Requirements

## repomind index

Must recursively scan, hash, detect changes, skip unchanged, summarize, populate SQLite. Output:

```
Indexed: 182 files
Skipped: 14 unchanged
Chunks: 911
Symbols: 486
Elapsed: 13.4s
```

## repomind ask

Must retrieve relevant chunks, answer only using retrieved context, cite file paths, produce `context_report.json`.

## repomind task

Must retrieve context, produce implementation plan, modify files, execute tests, write task report.

## repomind serve

Starts FastAPI dashboard.

---

# Testing

Write tests for: scanner, hashing, incremental indexing, parser, summarizer, retrieval ranking, context budgeting, fixture generation, API routes.

`pytest` must pass.

---

# Verification

1. Generate the large fixture repository.
2. Run `repomind index fixtures/generated_repo`.
3. Ask: "What does this repository do?", "Where is authentication implemented?", "Which modules are central?", "What hidden requirements exist?", "Where should logging be added?", "Which files can be deleted?"
4. Run `repomind task "Add structured logging to indexing."`
5. Run all tests.
6. Save everything into `artifacts/verification.md`.

---

# Completion Criteria

Do not declare completion until:

• CLI works
• SQLite works
• Incremental indexing works
• Retrieval works
• Context reports are generated
• FastAPI starts successfully
• Fixture generator works
• Tests pass
• README is complete
• Verification document exists

Never fabricate results. If something cannot be completed, explicitly explain why.

At the end provide:

• Files created
• Files modified
• Commands executed
• Test results
• Known limitations
• Recommended future improvements