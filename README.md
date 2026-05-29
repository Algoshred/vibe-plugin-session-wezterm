# @vibecontrols/vibe-plugin-session-wezterm

<!-- VIBECONTROLS_OSS_HEADER_START -->

> **License**: MIT — see [LICENSE](./LICENSE).
> **Note**: This plugin is open source. The `@vibecontrols/agent` runtime that loads it is **not** open source — it is a proprietary product of Burdenoff Consultancy Services Pvt. Ltd. See [vibecontrols.com](https://vibecontrols.com) for the agent.

<!-- VIBECONTROLS_OSS_HEADER_END -->

WezTerm + ttyd session provider plugin for [VibeControls Agent](https://www.npmjs.com/package/@vibecontrols/agent).

Cross-platform alternative to the tmux session plugin — works on Windows, macOS, and Linux.

## Installation

```bash
vibe plugin install @vibecontrols/vibe-plugin-session-wezterm
```

Or install globally alongside the agent:

```bash
npm install -g @vibecontrols/vibe-plugin-session-wezterm
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

<!-- VIBECONTROLS_OSS_FOOTER_START -->

---

## License

Released under the [MIT License](./LICENSE).

Copyright (c) 2026 Burdenoff Consultancy Services Private Limited, Algoshred Technologies Private Limited, and all its sister companies.

Maintainer: **Vignesh T.V** — <https://github.com/tvvignesh>

## Credits

This plugin builds on the following upstream open-source projects. All trademarks and copyrights remain with their respective owners.

- **WezTerm** — <https://github.com/wezterm/wezterm>

## About VibeControls

**VibeControls** is the agentic engineering mission control for AI-native teams. Vibe-plugins extend the VibeControls agent with new providers, tools, sessions, tunnels, storage backends, and security stages.

- Website: <https://vibecontrols.com>
- Documentation: <https://docs.vibecontrols.com>
- Plugin SDK: <https://github.com/algoshred/vibecontrols-plugin-sdk>
- All plugins: <https://github.com/algoshred?q=vibe-plugin-&type=all>

## Important: agent is not open source

The `@vibecontrols/agent` runtime that loads and orchestrates these plugins is **closed source** and proprietary to Burdenoff Consultancy Services Pvt. Ltd. Only the plugin contract and the plugins themselves are released under MIT. If you want a fully self-hostable agent, please open an issue or contact the maintainer.

<!-- VIBECONTROLS_OSS_FOOTER_END -->
