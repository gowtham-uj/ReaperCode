# DeepSeek Harness UI source notice

The Reaper web interface is based on and adapted from the React web UI in
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), primarily
its client UI theme, layout, sidebar, conversation, chat, approval, model
selection, workspace, and settings packages.

DeepSeek Harness is Copyright (c) 2026 DeepSeek and is licensed under the MIT
License. The original license is preserved in `LICENSE` beside this notice.

Reaper replaces DeepSeek Harness's Cordis/plugin runtime and wire protocol with
Reaper's Vite entry, React application provider, JSON-RPC WebSocket client, and
thread-scoped browser gateway. Components and styles in the surrounding Reaper
UI have been adapted to Reaper's thread, transcript, approval, model, settings,
files, diff, output, preview, and browser surfaces.
