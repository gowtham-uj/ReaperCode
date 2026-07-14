# ReaperCode

Reaper is a model-agnostic TypeScript agent harness. It orchestrates a swarm of specialized agents (planners, executors, reviewers, testers, and scouts) to solve complex software engineering tasks autonomously. 

Inspired by powerful AI coding assistants, Reaper extends traditional agent patterns with robust worktree isolation, advanced context compaction, and provider routing.

## Key Features

- **Model Agnostic**: Seamlessly interfaces with state-of-the-art LLMs (Claude, GPT, DeepSeek, MiniMax) through unified provider adapters.
- **Swarm Orchestration**: Automatically spawns parallel read-only scouts to understand codebases, and isolated implementers to handle concurrent writes without collisions.
- **Advanced Context Engineering**: Never run out of tokens. Reaper features a sophisticated compaction pipeline including bash head/tail reduction, age-based pruning, context shaking, and delta-summarization, operating under a strict 270K hard cap.
- **Execution & Tooling**: Ships with a hardened execution engine featuring a secure `bash` tool, deep workspace integration, persistent memory scratchpads, and structured JSON reporting.
- **Security First**: Built-in secret redaction across durable context paths, trajectory logging, and strict shell-risk boundaries.

## Installation

Ensure you have [Node.js](https://nodejs.org/) installed, then clone the repository and install dependencies:

```bash
git clone https://github.com/gowtham-uj/ReaperCode.git
cd ReaperCode
npm install
npm run build
```

## Usage

Reaper provides multiple scripts to interface with the agent runtime:

```bash
# Run the Reaper agent interactively
npm run reaper

# Execute a specific prompt directly
npm run reaper:exec -- "Find all instances of legacy run_command and replace with bash"

# Run the typechecker
npm run typecheck

# Run the test suite
npm test
```

## Demo

> 📺 **Demo Video**: *(Placeholder)*

*(Note: Please record a short terminal session using `asciinema` or a screen recorder running `npm run reaper` and link the GIF/video here to showcase Reaper in action!)*

## Architecture overview

Reaper handles workflow in distinct operating modes:
- **SCOUT**: Read-only repository understanding.
- **PLAN**: Architecture and design formulation.
- **IMPLEMENT**: Patching with tests and reviews.
- **BUG HUNT**: Trace, patch, and regression-test.
- **REVIEW**: Code quality and security review.
- **SHIP**: End-to-end execution of the full lifecycle.

## License

ISC License.
