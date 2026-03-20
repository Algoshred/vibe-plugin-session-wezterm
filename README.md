# @burdenoff/vibe-plugin-session-wezterm

WezTerm + ttyd session provider plugin for [VibeControls Agent](https://www.npmjs.com/package/@burdenoff/vibe-agent).

Cross-platform alternative to the tmux session plugin — works on Windows, macOS, and Linux.

## Installation

```bash
vibe plugin install @burdenoff/vibe-plugin-session-wezterm
```

Or install globally alongside the agent:

```bash
npm install -g @burdenoff/vibe-plugin-session-wezterm
```

## Features

- **WezTerm Sessions** -- Create, manage, and destroy WezTerm terminal sessions via workspaces
- **Cross-Platform** -- Works on Windows, macOS, and Linux (unlike tmux which is Unix-only)
- **ttyd Integration** -- Web terminal access via ttyd (auto-started per session)
- **Headless Operation** -- Uses `wezterm-mux-server` for headless session management
- **Session Lifecycle** -- Full lifecycle management with health checks
- **Command Execution** -- Run commands in existing WezTerm sessions
- **Terminal Capture** -- Capture terminal output from running sessions
- **Port Management** -- Automatic free port allocation for ttyd instances

## Provider Interface

This plugin registers a `session` provider with the following capabilities:

| Method                 | Description                                              |
| ---------------------- | -------------------------------------------------------- |
| `create(config)`       | Create a new WezTerm session with optional ttyd terminal |
| `get(id)`              | Get session info by ID                                   |
| `list()`               | List all managed sessions                                |
| `terminate(id)`        | Kill a WezTerm session and its ttyd process              |
| `execute(id, command)` | Send a command to a WezTerm session                      |
| `capture(id)`          | Capture current terminal output                          |
| `startTerminal(id)`    | Start a ttyd web terminal for a session                  |
| `stopTerminal(id)`     | Stop the ttyd process for a session                      |
| `healthCheck()`        | Check WezTerm and ttyd health                            |
| `getSystemSessions()`  | List all system WezTerm workspaces                       |
| `getSystemTerminals()` | List all running ttyd processes                          |

## Requirements

- VibeControls Agent >= 2.0.0
- WezTerm installed on the host system (with `wezterm` CLI in PATH)
- ttyd installed on the host system (optional, for web terminals)
- Bun runtime >= 1.3.0

## License

Proprietary -- Copyright Burdenoff Consultancy Services Pvt. Ltd.
