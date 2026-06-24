# Computer Tools

These tools are native Reaper progressive-discovery tools. They are implemented in TypeScript/Node like the rest of Reaper’s core tools. They are not MCP tools. Use `search_tools` with queries such as `computer mouse`, `screen`, `keyboard`, `live view`, or `human approval` to discover them.

OS input uses Node native desktop automation packages. Actions time out after 30 seconds by default, clamp mouse coordinates to the screen, block dangerous key combinations, and write JSONL action records to `computer_control.log` in the run artifact directory.

## Tools

`mouse_move`

Moves the OS cursor with a curved human-like path.

```json
{ "x": 500, "y": 400, "duration": 0.2 }
```

`mouse_click`

Moves to the point, adds small jitter and a short pause, then clicks.

```json
{ "x": 500, "y": 400, "button": "left", "clicks": 1 }
```

`mouse_scroll`

Smooth scroll with optional inertia. Positive `deltaY` means scroll down.

```json
{ "deltaY": 600, "deltaX": 0, "inertia": true }
```

`keyboard_type`

Types text with variable delay. Typo injection is available but disabled by default.

```json
{ "text": "hello", "minDelay": 0.05, "maxDelay": 0.15, "typoProbability": 0 }
```

`keyboard_press`

Presses a key or key combination. Dangerous combinations are blocked unless `authorized: true`.

```json
{ "keys": ["ctrl", "c"], "duration": 0.1 }
```

`screenshot`

Captures the full screen or a region. Use `returnFormat: "path"` for large screenshots.

```json
{ "region": [0, 0, 1280, 720], "returnFormat": "base64" }
```

`get_screen_size`

```json
{}
```

`get_mouse_position`

```json
{}
```

`wait`

```json
{ "seconds": 1.0, "jitter": 0.2 }
```

`start_live_view`

Starts the live screen stream. Default URL is `http://127.0.0.1:8765/live`.

```json
{ "host": "127.0.0.1", "port": 8765 }
```

`stop_live_view`

```json
{}
```

`request_human_approval`

Blocks for a local approval UI. `Take Over` marks the session as human-controlled until released.

```json
{ "reason": "Confirm before deleting the selected file", "timeoutSeconds": 300 }
```

`is_human_intervening`

```json
{}
```

## Setup

The Node dependencies are part of `package.json`:

```bash
npm install
```

On Linux, the process must run inside an unlocked desktop session and may need packages such as `libxtst6`, `libx11-xcb1`, and ImageMagick/scrot for screenshots depending on the environment. On macOS and Windows, grant screen-recording/accessibility permissions to the terminal or Node runtime.
