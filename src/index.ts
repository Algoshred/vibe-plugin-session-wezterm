/**
 * @vibecontrols/vibe-plugin-session-wezterm
 *
 * WezTerm + ttyd session provider plugin for VibeControls Agent.
 * Implements the full SessionProvider interface (23 methods + 8 aliases) using
 * WezTerm workspaces for terminal session management and ttyd for
 * browser-accessible web terminals.
 *
 * Cross-platform: works on Windows, macOS, and Linux.
 * Uses `wezterm-mux-server` for headless operation (similar to tmux's server).
 */

// Subprocess type not needed — we track PIDs only for restart resilience
import { homedir, tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { Elysia } from "elysia";
import type {
  HostServices,
  ProfileContext,
  VibePlugin,
  VibePluginFactory,
} from "@vibecontrols/plugin-sdk/contract";
import { createLifecycleHooks } from "@vibecontrols/plugin-sdk/lifecycle";
import { TypedStore } from "@vibecontrols/plugin-sdk/storage";
import {
  findAvailablePort,
  gracefulKill,
  isProcessAlive,
  sleep,
} from "@vibecontrols/plugin-sdk/subprocess";
import { BoundLogger } from "@vibecontrols/plugin-sdk/log";
import { TelemetryEmitter } from "@vibecontrols/plugin-sdk/telemetry";
import { ProviderRegistry } from "@vibecontrols/plugin-sdk/providers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SessionStatus = "active" | "inactive" | "terminated" | "error";

interface SessionConfig {
  /** Optional external ID (e.g. backend UUID). If provided the plugin uses it instead of generating one. */
  id?: string;
  name: string;
  command?: string;
  workingDirectory?: string;
  environment?: Record<string, string>;
  shell?: string;
  size?: { cols: number; rows: number };
  projectId?: string;
  /** Optional provider-native session name. */
  externalName?: string;
}

interface SessionInfo {
  id: string;
  name: string;
  status: SessionStatus;
  provider: string;
  command?: string;
  workingDirectory?: string;
  pid?: number;
  projectId?: string;
  createdAt: string;
  updatedAt?: string;
  terminal?: TerminalInfo;
  metadata?: Record<string, unknown>;
}

interface TerminalInfo {
  url: string;
  port: number;
  pid: number;
}

interface HealthCheckResult {
  ok: boolean;
  sessions: number;
  terminals: number;
  message?: string;
}

interface SystemSessionInfo {
  id: string;
  name: string;
  windows: number;
  attached: boolean;
  createdAt?: string;
}

interface SystemTerminalInfo {
  pid: number;
  port: number;
  sessionId?: string;
}

interface SessionProvider {
  readonly name: string;
  create(config: SessionConfig): Promise<SessionInfo>;
  terminate(sessionId: string): Promise<void>;
  getInfo(sessionId: string): Promise<SessionInfo | null>;
  list(): Promise<SessionInfo[]>;
  sendCommand(sessionId: string, command: string): Promise<void>;
  sendKeys(sessionId: string, keys: string): Promise<void>;
  sendInterrupt(sessionId: string): Promise<void>;
  captureOutput(sessionId: string): Promise<string>;
  rename(sessionId: string, newName: string): Promise<void>;
  toggleMouse(sessionId: string): Promise<boolean>;
  getTerminationStatus(
    sessionId: string,
  ): Promise<{ terminated: boolean; exists: boolean }>;
  getTerminalInfo(sessionId: string): Promise<TerminalInfo | null>;
  startTerminal(sessionId: string, port?: number): Promise<TerminalInfo>;
  stopTerminal(sessionId: string): Promise<void>;
  listSystemSessions(): Promise<SystemSessionInfo[]>;
  listSystemTerminals(): Promise<SystemTerminalInfo[]>;
  bulkKillSystemSessions(
    sessionIds: string[],
  ): Promise<{ killed: number; failed: number }>;
  bulkKillSystemTerminals(
    pids: number[],
  ): Promise<{ killed: number; failed: number }>;
  healthCheck(): Promise<HealthCheckResult>;
  getSessionsByProject(projectId: string): Promise<SessionInfo[]>;
  cleanup(): Promise<{ cleaned: number }>;

  // Core agent interface aliases (routes use these names)
  get(sessionId: string): Promise<SessionInfo | null>;
  kill(sessionId: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  capture(
    sessionId: string,
    options?: { lines?: number; pane?: string },
  ): Promise<string>;
  resize(sessionId: string, cols: number, rows: number): Promise<void>;
  listSystem(): Promise<SystemSessionInfo[]>;
  killSystem(sessionId: string): Promise<void>;
  killSystemTerminal(pid: number): Promise<void>;

  // Optional capability & extended capture methods
  getCapabilities?(): SessionProviderCapabilities;
  getScrollback?(sessionId: string, lines: number): Promise<string>;
  searchOutput?(
    sessionId: string,
    pattern: string,
  ): Promise<Array<{ line: number; content: string }>>;

  // Optional orphan discovery / adoption
  discoverOrphans?(): Promise<OrphanSessionInfo[]>;
  adopt?(externalName: string, displayName?: string): Promise<SessionInfo>;
}

interface OrphanSessionInfo {
  externalName: string;
  provider: string;
  windows: number;
  attached: boolean;
  createdAt?: string;
}

interface SessionProviderCapabilities {
  provider: string;
  features: {
    mouse: boolean;
    resize: boolean;
    capture: boolean;
    webTerminal: boolean;
    splitPanes: boolean;
    tabs: boolean;
    scrollback: boolean;
    clipboard: boolean;
    search: boolean;
  };
  platform: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLUGIN_NAME = "session-wezterm";
const PLUGIN_VERSION = "2026.509.3";
const PROVIDER_NAME = "session-wezterm";
const STORAGE_NAMESPACE = "session-wezterm";
const STORAGE_KEY_SESSIONS = "sessions";
const STORAGE_KEY_TERMINALS = "terminals";
const TTYD_BASE_PORT = 7881;
const TTYD_PORT_RANGE = 200;

// ---------------------------------------------------------------------------
// WezTerm CLI list output shape
// ---------------------------------------------------------------------------

interface WeztermPaneInfo {
  window_id: number;
  tab_id: number;
  pane_id: number;
  workspace: string;
  size: string;
  title: string;
  cwd: string;
  cursor_x: number;
  cursor_y: number;
  cursor_visibility: string;
  cursor_shape: string;
  // wezterm cli list --format json may include additional fields
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a short random hex ID (8 chars) for session identifiers.
 */
function generateId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Check if we are running on Windows.
 */
function isWindows(): boolean {
  return process.platform === "win32";
}

/**
 * Execute a wezterm command and return its stdout. Throws on non-zero exit.
 */
function weztermExec(args: string[]): string {
  const result = Bun.spawnSync(["wezterm", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    throw new Error(`wezterm exited with code ${result.exitCode}: ${stderr}`);
  }
  return result.stdout.toString("utf-8").trimEnd();
}

/**
 * Execute a wezterm command, returning true on success, false on failure.
 * Does not throw.
 */
function weztermExecSilent(args: string[]): boolean {
  try {
    const result = Bun.spawnSync(["wezterm", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Execute a `wezterm cli` subcommand and return stdout. Throws on non-zero exit.
 */
function weztermCliExec(args: string[]): string {
  return weztermExec(["cli", ...args]);
}

/**
 * Execute a `wezterm cli` subcommand silently. Returns true on success.
 */
function weztermCliExecSilent(args: string[]): boolean {
  return weztermExecSilent(["cli", ...args]);
}

/**
 * List all wezterm panes as JSON. Returns parsed array of pane info objects.
 */
function weztermListPanes(): WeztermPaneInfo[] {
  try {
    const raw = weztermCliExec(["list", "--format", "json"]);
    if (!raw || raw === "[]") return [];
    return JSON.parse(raw) as WeztermPaneInfo[];
  } catch {
    return [];
  }
}

/**
 * Get the current ISO timestamp.
 */
function nowISO(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// WeztermSessionProvider
// ---------------------------------------------------------------------------

interface PersistedTerminalEntry {
  sessionId: string;
  pid: number;
  port: number;
}

class WeztermSessionProvider implements SessionProvider {
  readonly name = PROVIDER_NAME;

  /** Logger — bound to plugin source; no-op until init() supplies host logger. */
  private log: BoundLogger = new BoundLogger(undefined, PLUGIN_NAME);

  /** TypedStore handles — assigned in init() once host storage is available. */
  private sessionsStore: TypedStore<SessionInfo[]> | null = null;
  private terminalsStore: TypedStore<PersistedTerminalEntry[]> | null = null;

  /** In-memory map of ttyd PIDs keyed by session ID. */
  private ttydPids: Map<string, number> = new Map();

  /** In-memory map of ttyd port assignments keyed by session ID. */
  private ttydPorts: Map<string, number> = new Map();

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Initialise the provider with host services. Called from onServerStart.
   */
  async init(services: HostServices): Promise<void> {
    this.log = new BoundLogger(services.logger, PLUGIN_NAME);

    if (services.storage) {
      this.sessionsStore = new TypedStore<SessionInfo[]>(
        services.storage,
        STORAGE_NAMESPACE,
        STORAGE_KEY_SESSIONS,
        services.logger,
        PLUGIN_NAME,
      );
      this.terminalsStore = new TypedStore<PersistedTerminalEntry[]>(
        services.storage,
        STORAGE_NAMESPACE,
        STORAGE_KEY_TERMINALS,
        services.logger,
        PLUGIN_NAME,
      );
    }

    this.log.info("WeztermSessionProvider initialising", {
      provider: this.name,
    });

    // Auto-install wezterm if not available
    await this.ensureDependencies();

    // Ensure mux server is running for headless operation
    await this.ensureMuxServer();

    // Reconcile persisted sessions against actual wezterm state
    await this.reconcileSessions();

    this.log.info("WeztermSessionProvider ready");
  }

  /**
   * Graceful shutdown: stop all ttyd terminals.
   * When reason is 'reload', preserve sessions and ttyd processes for re-adoption.
   */
  async shutdown(context?: { reason: "reload" | "shutdown" }): Promise<void> {
    if (context?.reason === "reload") {
      this.log.info(
        "Hot-reload: preserving wezterm sessions and ttyd processes",
      );
      await this.persistTerminals();
      this.ttydPids.clear();
      this.ttydPorts.clear();
      return;
    }

    this.log.info("WeztermSessionProvider shutting down — stopping terminals");
    const stopPromises: Promise<void>[] = [];
    for (const [sessionId] of this.ttydPids) {
      stopPromises.push(this.stopTerminal(sessionId));
    }
    await Promise.allSettled(stopPromises);
    try {
      await this.terminalsStore?.delete();
    } catch {
      /* ignore */
    }
    this.log.info("WeztermSessionProvider shutdown complete");
  }

  // -----------------------------------------------------------------------
  // SessionProvider — create / terminate / getInfo / list
  // -----------------------------------------------------------------------

  async create(config: SessionConfig): Promise<SessionInfo> {
    // Attach-or-create on explicit externalName (workspace name).
    if (config.externalName) {
      const target = config.externalName;
      if (
        target.length === 0 ||
        target.length > 128 ||
        /[\0\r\n\s]/.test(target)
      ) {
        throw new Error(`Invalid externalName: ${target}`);
      }
      const sys = await this.listSystemSessions();
      if (sys.find((s) => s.name === target)) {
        this.log.info("create(): attaching to existing wezterm workspace", {
          target,
        });
        return this.adopt(target, config.name);
      }
      throw new Error(
        `No wezterm workspace named "${target}" — drop externalName to create a new one`,
      );
    }
    const id = config.id || generateId();
    const workspaceName = `vibe-${id.substring(0, 8)}`;
    const now = nowISO();

    this.log.info("Creating wezterm session", {
      id,
      name: config.name,
      workspaceName,
    });

    // Build wezterm cli spawn command
    const args: string[] = [
      "spawn",
      "--new-window",
      "--workspace",
      workspaceName,
    ];

    if (config.workingDirectory) {
      args.push("--cwd", config.workingDirectory);
    }

    // If a shell is specified, use it as the program to run
    if (config.shell) {
      args.push("--", config.shell);
    }

    let paneIdStr: string;
    try {
      // wezterm cli spawn returns the pane_id of the created pane
      paneIdStr = weztermCliExec(args);
    } catch (err) {
      this.log.error("Failed to create wezterm session", {
        id,
        error: String(err),
      });
      throw new Error(`Failed to create wezterm session: ${err}`, {
        cause: err,
      });
    }

    const paneId = parseInt(paneIdStr.trim(), 10);
    if (isNaN(paneId)) {
      throw new Error(
        `wezterm cli spawn returned invalid pane_id: ${paneIdStr}`,
      );
    }

    // Apply environment variables by sending export commands
    // (wezterm has no post-spawn set-environment, so we send export commands)
    if (config.environment) {
      for (const [key, value] of Object.entries(config.environment)) {
        const escaped = value.replace(/'/g, "'\\''");
        weztermCliExecSilent([
          "send-text",
          "--pane-id",
          String(paneId),
          "--no-paste",
          "--",
          `export ${key}='${escaped}'\n`,
        ]);
      }
      // Small delay for environment to settle
      await sleep(100);
    }

    // If an initial command is given, send it
    if (config.command) {
      weztermCliExecSilent([
        "send-text",
        "--pane-id",
        String(paneId),
        "--no-paste",
        "--",
        `${config.command}\n`,
      ]);
    }

    // Get the PID of the pane's process
    const pid = this.getPanePid(paneId);

    const info: SessionInfo = {
      id,
      name: config.name,
      status: "active",
      provider: this.name,
      command: config.command,
      workingDirectory: config.workingDirectory,
      pid: pid ?? undefined,
      projectId: config.projectId,
      createdAt: now,
      updatedAt: now,
      metadata: {
        weztermPaneId: paneId,
        weztermWorkspace: workspaceName,
        shell: config.shell,
        size: config.size,
      },
    };

    await this.saveSession(info);

    this.log.info("WezTerm session created", {
      id,
      workspaceName,
      paneId,
      pid,
    });
    return info;
  }

  async terminate(sessionId: string): Promise<void> {
    const session = await this.getInfo(sessionId);
    if (!session) {
      this.log.warn("Terminate called for unknown session", { sessionId });
      return;
    }

    const workspaceName = this.getWorkspaceName(session);
    this.log.info("Terminating wezterm session", {
      sessionId,
      workspaceName,
    });

    // Stop terminal first if running
    if (this.ttydPids.has(sessionId)) {
      await this.stopTerminal(sessionId);
    }

    // Kill all panes in the workspace
    const panes = weztermListPanes().filter(
      (p) => p.workspace === workspaceName,
    );
    for (const pane of panes) {
      weztermCliExecSilent(["kill-pane", "--pane-id", String(pane.pane_id)]);
    }

    // If no panes were found, try killing the stored pane directly
    if (panes.length === 0) {
      const paneId = this.getPaneId(session);
      if (paneId !== null) {
        weztermCliExecSilent(["kill-pane", "--pane-id", String(paneId)]);
      }
    }

    // Update stored state
    session.status = "terminated";
    session.updatedAt = nowISO();
    session.terminal = undefined;
    await this.saveSession(session);

    this.log.info("WezTerm session terminated", { sessionId });
  }

  async getInfo(sessionId: string): Promise<SessionInfo | null> {
    const sessions = await this.loadSessions();
    const session = sessions.find((s) => s.id === sessionId) ?? null;

    if (session) {
      // Refresh live status from wezterm
      const workspaceName = this.getWorkspaceName(session);
      const exists = this.workspaceExists(workspaceName);
      if (!exists && session.status === "active") {
        session.status = "inactive";
        session.updatedAt = nowISO();
        await this.saveSession(session);
      } else if (exists && session.status === "inactive") {
        session.status = "active";
        session.updatedAt = nowISO();
        await this.saveSession(session);
      }

      // Attach terminal info if running
      const termInfo = this.getRunningTerminalInfo(sessionId);
      if (termInfo) {
        session.terminal = termInfo;
      }
    }

    return session;
  }

  async list(): Promise<SessionInfo[]> {
    const sessions = await this.loadSessions();
    // Refresh statuses
    for (const session of sessions) {
      if (session.status === "terminated") continue;
      const workspaceName = this.getWorkspaceName(session);
      const exists = this.workspaceExists(workspaceName);
      if (!exists && session.status === "active") {
        session.status = "inactive";
        session.updatedAt = nowISO();
      } else if (exists && session.status !== "active") {
        session.status = "active";
        session.updatedAt = nowISO();
      }
      // Attach terminal info
      const termInfo = this.getRunningTerminalInfo(session.id);
      if (termInfo) {
        session.terminal = termInfo;
      }
    }
    await this.saveSessions(sessions);
    return sessions;
  }

  // -----------------------------------------------------------------------
  // SessionProvider — command / keys / interrupt / capture
  // -----------------------------------------------------------------------

  async sendCommand(sessionId: string, command: string): Promise<void> {
    const session = await this.requireSession(sessionId);
    const paneId = this.requirePaneId(session);

    this.log.debug("Sending command", { sessionId, command });
    try {
      weztermCliExec([
        "send-text",
        "--pane-id",
        String(paneId),
        "--no-paste",
        "--",
        `${command}\n`,
      ]);
    } catch (err) {
      this.log.error("Failed to send command", {
        sessionId,
        error: String(err),
      });
      throw new Error(
        `Failed to send command to session ${sessionId}: ${err}`,
        { cause: err },
      );
    }
  }

  async sendKeys(sessionId: string, keys: string): Promise<void> {
    const session = await this.requireSession(sessionId);
    const paneId = this.requirePaneId(session);

    this.log.debug("Sending keys", { sessionId, keys });
    try {
      weztermCliExec([
        "send-text",
        "--pane-id",
        String(paneId),
        "--no-paste",
        "--",
        keys,
      ]);
    } catch (err) {
      this.log.error("Failed to send keys", {
        sessionId,
        error: String(err),
      });
      throw new Error(`Failed to send keys to session ${sessionId}: ${err}`, {
        cause: err,
      });
    }
  }

  async sendInterrupt(sessionId: string): Promise<void> {
    const session = await this.requireSession(sessionId);
    const paneId = this.requirePaneId(session);

    this.log.debug("Sending interrupt (Ctrl+C)", { sessionId });
    try {
      weztermCliExec([
        "send-text",
        "--pane-id",
        String(paneId),
        "--no-paste",
        "--",
        "\x03",
      ]);
    } catch (err) {
      this.log.error("Failed to send interrupt", {
        sessionId,
        error: String(err),
      });
      throw new Error(
        `Failed to send interrupt to session ${sessionId}: ${err}`,
        { cause: err },
      );
    }
  }

  async captureOutput(sessionId: string): Promise<string> {
    const session = await this.requireSession(sessionId);
    const paneId = this.requirePaneId(session);

    this.log.debug("Capturing output", { sessionId });
    try {
      const output = weztermCliExec(["get-text", "--pane-id", String(paneId)]);
      return output;
    } catch (err) {
      this.log.error("Failed to capture output", {
        sessionId,
        error: String(err),
      });
      throw new Error(
        `Failed to capture output from session ${sessionId}: ${err}`,
        { cause: err },
      );
    }
  }

  // -----------------------------------------------------------------------
  // SessionProvider — rename / toggleMouse / getTerminationStatus
  // -----------------------------------------------------------------------

  async rename(sessionId: string, newName: string): Promise<void> {
    const session = await this.requireSession(sessionId);

    this.log.info("Renaming session", {
      sessionId,
      from: session.name,
      to: newName,
    });

    try {
      // Rename the display name in our records
      session.name = newName;
      session.updatedAt = nowISO();
      await this.saveSession(session);
    } catch (err) {
      this.log.error("Failed to rename session", {
        sessionId,
        error: String(err),
      });
      throw new Error(`Failed to rename session ${sessionId}: ${err}`, {
        cause: err,
      });
    }

    // Also try to rename the wezterm workspace for cosmetic purposes
    const oldWorkspace = this.getWorkspaceName(session);
    const newWorkspace = `vibe-${session.id}`;
    weztermCliExecSilent([
      "rename-workspace",
      "--workspace",
      oldWorkspace,
      newWorkspace,
    ]);
  }

  async toggleMouse(_sessionId: string): Promise<boolean> {
    // WezTerm always has mouse support enabled — this is a no-op.
    // Return true to indicate mouse is on.
    this.log.debug("toggleMouse is a no-op for wezterm (always enabled)", {
      sessionId: _sessionId,
    });
    return true;
  }

  async getTerminationStatus(
    sessionId: string,
  ): Promise<{ terminated: boolean; exists: boolean }> {
    const sessions = await this.loadSessions();
    const session = sessions.find((s) => s.id === sessionId);

    if (!session) {
      return { terminated: true, exists: false };
    }

    const workspaceName = this.getWorkspaceName(session);
    const exists = this.workspaceExists(workspaceName);

    return {
      terminated: session.status === "terminated" || !exists,
      exists,
    };
  }

  // -----------------------------------------------------------------------
  // SessionProvider — terminal (ttyd) management
  // -----------------------------------------------------------------------

  async getTerminalInfo(sessionId: string): Promise<TerminalInfo | null> {
    return this.getRunningTerminalInfo(sessionId);
  }

  async startTerminal(sessionId: string, port?: number): Promise<TerminalInfo> {
    const session = await this.requireSession(sessionId);
    const paneId = this.requirePaneId(session);

    // If already running, return existing info
    const existing = this.getRunningTerminalInfo(sessionId);
    if (existing) {
      this.log.debug("Terminal already running", { sessionId, ...existing });
      return existing;
    }

    // Find available port
    const assignedPort =
      port ?? (await findAvailablePort(TTYD_BASE_PORT, TTYD_PORT_RANGE));

    this.log.info("Starting ttyd terminal", {
      sessionId,
      paneId,
      port: assignedPort,
    });

    // Spawn ttyd process.
    // Unlike tmux (which has `tmux attach`), wezterm's headless mux server
    // does not expose an "attach to pane" command suitable for wrapping with
    // ttyd. Instead we start ttyd with a shell in the session's working
    // directory. The wezterm workspace tracks the session lifecycle while
    // ttyd provides the browser-accessible terminal.
    const cwd = session.workingDirectory || homedir();
    // Default shell is platform-aware: Windows has no /bin/bash, so fall back
    // to the comspec (cmd.exe) there and to $SHELL/bash on POSIX systems.
    const defaultShell = isWindows()
      ? process.env.ComSpec || "cmd.exe"
      : process.env.SHELL || "/bin/bash";
    const shell = (session.metadata?.shell as string) || defaultShell;

    // Build the ttyd shell environment.
    // Set wezterm-identifying vars, and if the agent itself is running inside
    // a different provider (e.g. tmux), remove that provider's vars so the
    // ttyd shell correctly identifies as wezterm-managed.
    const ttydEnv: Record<string, string | undefined> = { ...process.env };

    // Set wezterm identity
    ttydEnv.WEZTERM_PANE = String(paneId);
    ttydEnv.WEZTERM_UNIX_SOCKET =
      process.env.WEZTERM_UNIX_SOCKET || "managed-by-vibecontrols";
    ttydEnv.TERM_PROGRAM = "WezTerm";
    ttydEnv.VIBECONTROLS_PROVIDER = "wezterm";

    // If the agent is running inside another provider, clean those vars.
    // Each provider registers the env vars that identify it; when spawning
    // a session for a *different* provider we strip the inherited ones.
    const otherProviderVars: Record<string, string[]> = {
      tmux: ["TMUX", "TMUX_PANE", "TMUX_PLUGIN_MANAGER_PATH"],
      screen: ["STY", "WINDOW"],
      zellij: ["ZELLIJ", "ZELLIJ_SESSION_NAME", "ZELLIJ_PANE_ID"],
    };
    for (const vars of Object.values(otherProviderVars)) {
      for (const v of vars) {
        if (v in ttydEnv) delete ttydEnv[v];
      }
    }

    const child = Bun.spawn(
      [
        "ttyd",
        "-t",
        "fontSize=14",
        "-t",
        `theme={"background":"#1e1e1e","foreground":"#cccccc"}`,
        "--writable",
        "--port",
        String(assignedPort),
        shell,
      ],
      {
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
        cwd,
        env: ttydEnv as Record<string, string>,
      },
    );

    if (!child.pid) {
      throw new Error("Failed to start ttyd — no PID returned");
    }

    // Give ttyd a moment to bind the port
    await sleep(500);

    // Store references
    this.ttydPids.set(sessionId, child.pid);
    this.ttydPorts.set(sessionId, assignedPort);
    await this.persistTerminals();

    const terminalInfo: TerminalInfo = {
      url: `http://localhost:${assignedPort}`,
      port: assignedPort,
      pid: child.pid,
    };

    // Update session record with terminal info
    session.terminal = terminalInfo;
    session.updatedAt = nowISO();
    await this.saveSession(session);

    this.log.info("ttyd terminal started", {
      sessionId,
      port: assignedPort,
      pid: child.pid,
    });

    return terminalInfo;
  }

  async stopTerminal(sessionId: string): Promise<void> {
    const pid = this.ttydPids.get(sessionId);
    if (!pid) {
      this.log.debug("No ttyd process found for session", { sessionId });
      return;
    }

    this.log.info("Stopping ttyd terminal", {
      sessionId,
      pid,
    });

    await gracefulKill(pid);

    this.ttydPids.delete(sessionId);
    this.ttydPorts.delete(sessionId);
    await this.persistTerminals();

    // Clear terminal from session record
    const session = await this.getInfo(sessionId);
    if (session) {
      session.terminal = undefined;
      session.updatedAt = nowISO();
      await this.saveSession(session);
    }

    this.log.info("ttyd terminal stopped", { sessionId });
  }

  // -----------------------------------------------------------------------
  // SessionProvider — system-level listing and bulk operations
  // -----------------------------------------------------------------------

  async listSystemSessions(): Promise<SystemSessionInfo[]> {
    try {
      const panes = weztermListPanes();
      if (panes.length === 0) return [];

      // Group panes by workspace to produce one entry per workspace
      const workspaceMap = new Map<
        string,
        { panes: WeztermPaneInfo[]; windows: Set<number> }
      >();

      for (const pane of panes) {
        const ws = pane.workspace || "default";
        if (!workspaceMap.has(ws)) {
          workspaceMap.set(ws, { panes: [], windows: new Set() });
        }
        const entry = workspaceMap.get(ws)!;
        entry.panes.push(pane);
        entry.windows.add(pane.window_id);
      }

      const results: SystemSessionInfo[] = [];
      for (const [workspace, data] of workspaceMap) {
        results.push({
          id: workspace,
          name: workspace,
          windows: data.windows.size,
          attached: false, // wezterm cli list doesn't expose attachment state
        });
      }

      return results;
    } catch {
      return [];
    }
  }

  async listSystemTerminals(): Promise<SystemTerminalInfo[]> {
    const terminals: SystemTerminalInfo[] = [];

    for (const [sessionId, pid] of this.ttydPids) {
      const port = this.ttydPorts.get(sessionId);
      if (pid && port !== undefined) {
        terminals.push({
          pid,
          port,
          sessionId,
        });
      }
    }

    // Also look for any orphaned ttyd processes via pgrep (Unix only)
    if (!isWindows()) {
      try {
        const pgrepResult = Bun.spawnSync(["pgrep", "-a", "ttyd"], {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
        });
        const raw = pgrepResult.stdout.toString().trim();

        if (raw) {
          for (const line of raw.split("\n")) {
            const parts = line.trim().split(/\s+/);
            const pid = parseInt(parts[0] ?? "0", 10);
            if (!pid) continue;

            // Skip already-tracked processes
            const alreadyTracked = [...this.ttydPids.values()].includes(pid);
            if (alreadyTracked) continue;

            // Try to extract port from command line
            const portIdx = parts.indexOf("--port");
            const port =
              portIdx !== -1 ? parseInt(parts[portIdx + 1] ?? "0", 10) : 0;

            terminals.push({ pid, port: port || 0 });
          }
        }
      } catch {
        // pgrep returns non-zero when no processes found — that's fine
      }
    }

    return terminals;
  }

  async bulkKillSystemSessions(
    sessionIds: string[],
  ): Promise<{ killed: number; failed: number }> {
    let killed = 0;
    let failed = 0;

    // sessionIds here are workspace names when coming from listSystemSessions
    for (const wsName of sessionIds) {
      const panes = weztermListPanes().filter((p) => p.workspace === wsName);
      if (panes.length === 0) {
        // Try killing as a pane ID directly
        const success = weztermCliExecSilent([
          "kill-pane",
          "--pane-id",
          wsName,
        ]);
        if (success) {
          killed++;
        } else {
          failed++;
        }
      } else {
        let wsKilled = false;
        for (const pane of panes) {
          const success = weztermCliExecSilent([
            "kill-pane",
            "--pane-id",
            String(pane.pane_id),
          ]);
          if (success) wsKilled = true;
        }
        if (wsKilled) {
          killed++;
        } else {
          failed++;
        }
      }
    }

    this.log.info("Bulk kill system sessions", { killed, failed });
    return { killed, failed };
  }

  async bulkKillSystemTerminals(
    pids: number[],
  ): Promise<{ killed: number; failed: number }> {
    let killed = 0;
    let failed = 0;

    const killPromises = pids.map(async (pid) => {
      try {
        await gracefulKill(pid);
        killed++;

        // Remove from tracked processes if present
        for (const [sessionId, trackedPid] of this.ttydPids) {
          if (trackedPid === pid) {
            this.ttydPids.delete(sessionId);
            this.ttydPorts.delete(sessionId);
            break;
          }
        }
      } catch {
        failed++;
      }
    });

    await Promise.allSettled(killPromises);

    this.log.info("Bulk kill system terminals", { killed, failed });
    return { killed, failed };
  }

  // -----------------------------------------------------------------------
  // SessionProvider — health / project filter / cleanup
  // -----------------------------------------------------------------------

  async healthCheck(): Promise<HealthCheckResult> {
    let weztermOk: boolean;
    let weztermVersion: string;
    let sessionCount = 0;
    const terminalCount = this.ttydPids.size;

    try {
      weztermVersion = weztermExec(["--version"]);
      weztermOk = true;
    } catch {
      return {
        ok: false,
        sessions: 0,
        terminals: terminalCount,
        message: "wezterm is not available",
      };
    }

    try {
      const sysSessions = await this.listSystemSessions();
      sessionCount = sysSessions.length;
    } catch {
      // Ignore — zero sessions
    }

    // Check ttyd availability via Bun.which (handles PATHEXT on Windows).
    let ttydOk = false;
    try {
      ttydOk = Bun.which("ttyd") !== null;
    } catch {
      // ttyd not found
    }

    const messages: string[] = [weztermVersion];
    if (!ttydOk) {
      messages.push("ttyd not found — web terminals unavailable");
    }

    return {
      ok: weztermOk,
      sessions: sessionCount,
      terminals: terminalCount,
      message: messages.join("; "),
    };
  }

  async getSessionsByProject(projectId: string): Promise<SessionInfo[]> {
    const sessions = await this.list();
    return sessions.filter((s) => s.projectId === projectId);
  }

  async cleanup(): Promise<{ cleaned: number }> {
    this.log.info("Running cleanup");

    const sessions = await this.loadSessions();
    let cleaned = 0;
    const kept: SessionInfo[] = [];

    for (const session of sessions) {
      const workspaceName = this.getWorkspaceName(session);
      const exists = this.workspaceExists(workspaceName);

      if (session.status === "terminated" || !exists) {
        // Stop terminal if somehow still running
        if (this.ttydPids.has(session.id)) {
          await this.stopTerminal(session.id);
        }

        // Kill the wezterm panes if they still exist but session was marked terminated
        if (exists && session.status === "terminated") {
          const panes = weztermListPanes().filter(
            (p) => p.workspace === workspaceName,
          );
          for (const pane of panes) {
            weztermCliExecSilent([
              "kill-pane",
              "--pane-id",
              String(pane.pane_id),
            ]);
          }
        }

        cleaned++;
        this.log.debug("Cleaned session", {
          id: session.id,
          name: session.name,
        });
      } else {
        kept.push(session);
      }
    }

    await this.saveSessions(kept);

    this.log.info("Cleanup complete", { cleaned, remaining: kept.length });
    return { cleaned };
  }

  // -----------------------------------------------------------------------
  // Core agent interface aliases
  // The core SessionProvider interface uses these names; delegate to our
  // implementations so the session routes work correctly.
  // -----------------------------------------------------------------------

  async get(sessionId: string): Promise<SessionInfo | null> {
    return this.getInfo(sessionId);
  }

  async kill(sessionId: string): Promise<void> {
    return this.terminate(sessionId);
  }

  async interrupt(sessionId: string): Promise<void> {
    return this.sendInterrupt(sessionId);
  }

  async capture(sessionId: string): Promise<string> {
    return this.captureOutput(sessionId);
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    const session = await this.requireSession(sessionId);
    const paneId = this.requirePaneId(session);

    // WezTerm CLI does not have a direct set-size command for panes.
    // adjust-pane-size only works in direction-based increments, not absolute.
    // Log a warning — the terminal will auto-size based on the GUI window or
    // the ttyd terminal size.
    this.log.warn(
      "resize: WezTerm CLI does not support absolute pane resize. " +
        "The pane will auto-size based on the window or ttyd terminal.",
      { sessionId, paneId, requestedCols: cols, requestedRows: rows },
    );
  }

  async listSystem(): Promise<SystemSessionInfo[]> {
    return this.listSystemSessions();
  }

  async killSystem(sessionId: string): Promise<void> {
    // sessionId is a workspace name from listSystemSessions
    const panes = weztermListPanes().filter((p) => p.workspace === sessionId);
    for (const pane of panes) {
      weztermCliExecSilent(["kill-pane", "--pane-id", String(pane.pane_id)]);
    }
  }

  async killSystemTerminal(pid: number): Promise<void> {
    await gracefulKill(pid);
    // Remove from tracked processes if present
    for (const [sessionId, trackedPid] of this.ttydPids) {
      if (trackedPid === pid) {
        this.ttydPids.delete(sessionId);
        this.ttydPorts.delete(sessionId);
        break;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Orphan discovery & adoption
  // wezterm workspaces survive agent restarts. Same pattern as tmux —
  // expose `vibe-*` workspaces not in storage so the UI can reconnect.
  // -----------------------------------------------------------------------

  async discoverOrphans(): Promise<OrphanSessionInfo[]> {
    const known = new Set(
      (await this.loadSessions())
        .filter((s) => s.status !== "terminated")
        .map((s) => this.getWorkspaceName(s)),
    );
    const sys = await this.listSystemSessions();
    return sys
      .filter((s) => s.name.startsWith("vibe-") && !known.has(s.name))
      .map((s) => ({
        externalName: s.name,
        provider: "wezterm",
        windows: s.windows,
        attached: s.attached,
        createdAt: s.createdAt,
      }));
  }

  async adopt(
    externalName: string,
    displayName?: string,
  ): Promise<SessionInfo> {
    if (!externalName.startsWith("vibe-")) {
      throw new Error(
        `Refusing to adopt wezterm workspace "${externalName}" — only vibe-* workspaces are adoptable`,
      );
    }
    const sys = await this.listSystemSessions();
    if (!sys.find((s) => s.name === externalName)) {
      throw new Error(`Wezterm workspace "${externalName}" does not exist`);
    }
    const id = externalName.slice("vibe-".length) || externalName;
    const existing = (await this.loadSessions()).find((s) => s.id === id);
    if (existing) {
      if (!this.ttydPids.has(id)) {
        try {
          await this.startTerminal(id);
        } catch {
          /* best-effort */
        }
      }
      return (await this.get(id)) ?? existing;
    }
    const now = nowISO();
    const info: SessionInfo = {
      id,
      name: displayName || externalName,
      status: "active",
      provider: this.name,
      createdAt: now,
      updatedAt: now,
      metadata: {
        weztermWorkspace: externalName,
        adopted: true,
      },
    };
    await this.saveSession(info);
    try {
      info.terminal = await this.startTerminal(id);
      await this.saveSession(info);
    } catch {
      /* best-effort */
    }
    return info;
  }

  // -----------------------------------------------------------------------
  // Capability & extended capture methods
  // -----------------------------------------------------------------------

  getCapabilities(): SessionProviderCapabilities {
    return {
      provider: "wezterm",
      features: {
        mouse: true,
        resize: true,
        capture: true,
        webTerminal: true,
        splitPanes: true,
        tabs: true,
        scrollback: true,
        clipboard: true,
        search: true,
      },
      platform: ["linux", "macos", "windows"],
    };
  }

  async getScrollback(sessionId: string, lines: number): Promise<string> {
    const session = await this.requireSession(sessionId);
    const paneId = this.requirePaneId(session);

    this.log.debug("Getting scrollback", { sessionId, lines });
    try {
      // WezTerm get-text captures the full scrollback by default;
      // we trim to the requested number of lines from the end
      const output = weztermCliExec(["get-text", "--pane-id", String(paneId)]);
      const allLines = output.split("\n");
      const sliced = allLines.slice(-lines);
      return sliced.join("\n");
    } catch (err) {
      this.log.error("Failed to get scrollback", {
        sessionId,
        error: String(err),
      });
      throw new Error(
        `Failed to get scrollback for session ${sessionId}: ${err}`,
        {
          cause: err,
        },
      );
    }
  }

  async searchOutput(
    sessionId: string,
    pattern: string,
  ): Promise<Array<{ line: number; content: string }>> {
    // Capture scrollback and search through it
    const scrollback = await this.getScrollback(sessionId, 10000);
    const lines = scrollback.split("\n");
    const results: Array<{ line: number; content: string }> = [];

    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch {
      regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    }

    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i] ?? "")) {
        results.push({ line: i + 1, content: lines[i] ?? "" });
      }
    }

    this.log.debug("Search output completed", {
      sessionId,
      pattern,
      matches: results.length,
    });

    return results;
  }

  // -----------------------------------------------------------------------
  // Private helpers — storage
  // -----------------------------------------------------------------------

  /**
   * Load all session records from persistent storage.
   */
  private async loadSessions(): Promise<SessionInfo[]> {
    if (!this.sessionsStore) return [];
    const data = await this.sessionsStore.get();
    return data ?? [];
  }

  /**
   * Save the full session list to persistent storage.
   */
  private async saveSessions(sessions: SessionInfo[]): Promise<void> {
    if (!this.sessionsStore) return;
    try {
      await this.sessionsStore.set(sessions);
    } catch (err) {
      this.log.error("Failed to save sessions to storage", {
        error: String(err),
      });
    }
  }

  /**
   * Save (upsert) a single session record.
   */
  private async saveSession(session: SessionInfo): Promise<void> {
    const sessions = await this.loadSessions();
    const idx = sessions.findIndex((s) => s.id === session.id);
    if (idx >= 0) {
      sessions[idx] = session;
    } else {
      sessions.push(session);
    }
    await this.saveSessions(sessions);
  }

  // -----------------------------------------------------------------------
  // Private helpers — wezterm utilities
  // -----------------------------------------------------------------------

  /**
   * Extract the wezterm workspace name from a SessionInfo record.
   */
  private getWorkspaceName(session: SessionInfo): string {
    const meta = session.metadata as Record<string, unknown> | undefined;
    if (meta && typeof meta.weztermWorkspace === "string") {
      return meta.weztermWorkspace;
    }
    return `vibe-${session.id}`;
  }

  /**
   * Extract the wezterm pane ID from a SessionInfo record.
   */
  private getPaneId(session: SessionInfo): number | null {
    const meta = session.metadata as Record<string, unknown> | undefined;
    if (meta && typeof meta.weztermPaneId === "number") {
      return meta.weztermPaneId;
    }
    return null;
  }

  /**
   * Extract the pane ID from a session, throwing if not found.
   */
  private requirePaneId(session: SessionInfo): number {
    const paneId = this.getPaneId(session);
    if (paneId === null) {
      throw new Error(
        `No wezterm pane ID found for session ${session.id}. Session may be corrupted.`,
      );
    }
    return paneId;
  }

  /**
   * Check if a workspace exists (has any panes).
   */
  private workspaceExists(workspaceName: string): boolean {
    const panes = weztermListPanes();
    return panes.some((p) => p.workspace === workspaceName);
  }

  /**
   * Get the PID of a process running in a wezterm pane.
   */
  private getPanePid(paneId: number): number | null {
    try {
      const panes = weztermListPanes();
      const pane = panes.find((p) => p.pane_id === paneId);
      if (pane && typeof pane.pid === "number") {
        return pane.pid;
      }
      // Some wezterm versions may not include pid in list output
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Look up a session by ID and throw if not found.
   */
  private async requireSession(sessionId: string): Promise<SessionInfo> {
    const session = await this.getInfo(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (session.status === "terminated") {
      throw new Error(`Session is terminated: ${sessionId}`);
    }
    return session;
  }

  /**
   * Get TerminalInfo for a session if ttyd is currently running.
   */
  private getRunningTerminalInfo(sessionId: string): TerminalInfo | null {
    const pid = this.ttydPids.get(sessionId);
    const port = this.ttydPorts.get(sessionId);

    if (!pid || port === undefined) {
      return null;
    }

    // Verify process is still alive
    if (!isProcessAlive(pid)) {
      this.ttydPids.delete(sessionId);
      this.ttydPorts.delete(sessionId);
      return null;
    }

    return {
      url: `http://localhost:${port}`,
      port,
      pid,
    };
  }

  /**
   * Ensure the wezterm mux server is running for headless operation.
   * Auto-install wezterm if not found in PATH.
   * Each plugin owns its own binary installation (adapter pattern).
   */
  private async ensureDependencies(): Promise<void> {
    try {
      const version = weztermExec(["--version"]);
      this.log.info("wezterm detected", { version: version.trim() });
      return;
    } catch {
      this.log.info("wezterm not found — attempting auto-install");
    }

    const platform = process.platform;
    const homeDir = process.env.HOME || process.env.USERPROFILE || tmpdir();

    try {
      if (platform === "linux") {
        // Download AppImage, extract, create wrapper scripts. Use tmpdir()
        // (honours TMPDIR) instead of hardcoded /tmp so installs work in
        // sandboxed environments where /tmp is read-only.
        const binDir = `${homeDir}/bin`;
        const distDir = `${binDir}/wezterm-dist`;
        const tmpRoot = tmpdir();
        const appImagePath = joinPath(tmpRoot, "wezterm.AppImage");
        const squashRoot = joinPath(tmpRoot, "squashfs-root");
        Bun.spawnSync(["mkdir", "-p", binDir], { timeout: 5_000 });

        const appImageUrl =
          "https://github.com/wezterm/wezterm/releases/download/20240203-110809-5046fc22/WezTerm-20240203-110809-5046fc22-Ubuntu20.04.AppImage";
        this.log.info("Downloading WezTerm AppImage...");
        const dl = Bun.spawnSync(
          ["curl", "-sL", appImageUrl, "-o", appImagePath],
          { timeout: 120_000, stdout: "pipe", stderr: "pipe" },
        );
        if (dl.exitCode !== 0)
          throw new Error(`Download failed: ${dl.stderr.toString()}`);

        // chmod +x is meaningless on Windows (no POSIX execute bit), but
        // this entire branch is gated by `platform === "linux"`. Still, we
        // keep the call platform-defensive in case of future refactors.
        if (process.platform !== "win32") {
          Bun.spawnSync(["chmod", "+x", appImagePath], { timeout: 5_000 });
        }

        // Extract (no FUSE needed)
        Bun.spawnSync(
          [
            "sh",
            "-c",
            `cd ${tmpRoot} && ./wezterm.AppImage --appimage-extract`,
          ],
          { timeout: 30_000, stdout: "pipe", stderr: "pipe" },
        );

        // Copy binaries
        Bun.spawnSync(["mkdir", "-p", distDir], { timeout: 5_000 });
        Bun.spawnSync(
          [
            "sh",
            "-c",
            `cp ${squashRoot}/usr/bin/* ${distDir}/ && cp -r ${squashRoot}/usr/lib ${distDir}/lib 2>/dev/null; true`,
          ],
          { timeout: 10_000, stdout: "pipe", stderr: "pipe" },
        );

        // Create wrapper scripts with LD_LIBRARY_PATH
        for (const bin of ["wezterm", "wezterm-mux-server"]) {
          const wrapper = `#!/bin/bash\nexport LD_LIBRARY_PATH="${distDir}/lib:$LD_LIBRARY_PATH"\nexec "${distDir}/${bin}" "$@"\n`;
          await Bun.write(`${binDir}/${bin}`, wrapper);
          if (process.platform !== "win32") {
            Bun.spawnSync(["chmod", "+x", `${binDir}/${bin}`], {
              timeout: 5_000,
            });
          }
        }

        // Cleanup
        Bun.spawnSync(["rm", "-rf", appImagePath, squashRoot], {
          timeout: 5_000,
        });

        // Add to PATH for current process
        process.env.PATH = `${binDir}:${process.env.PATH}`;
      } else if (platform === "darwin") {
        const r = Bun.spawnSync(["brew", "install", "--cask", "wezterm"], {
          timeout: 120_000,
          stdout: "pipe",
          stderr: "pipe",
        });
        if (r.exitCode !== 0) throw new Error(r.stderr.toString());
      } else if (platform === "win32") {
        const localApps =
          process.env.LOCALAPPDATA || `${homeDir}/AppData/Local`;
        const installDir = `${localApps}/Programs/WezTerm`;
        const zipUrl =
          "https://github.com/wezterm/wezterm/releases/download/20240203-110809-5046fc22/WezTerm-windows-20240203-110809-5046fc22.zip";
        const ps = Bun.spawnSync(
          [
            "powershell",
            "-Command",
            `New-Item -ItemType Directory -Force -Path '${installDir}'; Invoke-WebRequest -Uri '${zipUrl}' -OutFile '$env:TEMP\\wezterm.zip'; Expand-Archive -Force '$env:TEMP\\wezterm.zip' -DestinationPath '${installDir}'; Remove-Item '$env:TEMP\\wezterm.zip'`,
          ],
          { timeout: 120_000, stdout: "pipe", stderr: "pipe" },
        );
        if (ps.exitCode !== 0) throw new Error(ps.stderr.toString());
        process.env.PATH = `${installDir}:${process.env.PATH}`;
      }

      // Verify
      const version = weztermExec(["--version"]);
      this.log.info("wezterm auto-installed successfully", {
        version: version.trim(),
      });
    } catch (err) {
      this.log.error("Failed to auto-install wezterm", {
        error: String(err),
      });
      this.log.error(
        "wezterm is not available — session provider will not function",
      );
    }
  }

  /**
   * If `wezterm cli list` fails, start `wezterm-mux-server --daemonize`.
   */
  private async ensureMuxServer(): Promise<void> {
    // Try to connect to an existing mux server
    const connected = weztermCliExecSilent(["list"]);
    if (connected) {
      this.log.info("Connected to existing wezterm mux server");
      return;
    }

    this.log.info(
      "No wezterm mux server detected — starting wezterm-mux-server",
    );

    try {
      const daemonizeFlag = isWindows() ? [] : ["--daemonize"];
      Bun.spawnSync(["wezterm-mux-server", ...daemonizeFlag], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });

      // Wait for the mux server to be ready
      let ready = false;
      for (let i = 0; i < 10; i++) {
        await sleep(500);
        if (weztermCliExecSilent(["list"])) {
          ready = true;
          break;
        }
      }

      if (ready) {
        this.log.info("wezterm-mux-server started successfully");
      } else {
        this.log.error("wezterm-mux-server started but not responding to CLI");
      }
    } catch (err) {
      this.log.error("Failed to start wezterm-mux-server", {
        error: String(err),
      });
    }
  }

  /**
   * Persist current ttyd PID/port map to storage so a reloaded instance can
   * re-adopt the still-running ttyd processes.
   */
  private async persistTerminals(): Promise<void> {
    if (!this.terminalsStore) return;
    try {
      const entries: PersistedTerminalEntry[] = [];
      for (const [sessionId, pid] of this.ttydPids) {
        const port = this.ttydPorts.get(sessionId);
        if (port !== undefined) {
          entries.push({ sessionId, pid, port });
        }
      }
      await this.terminalsStore.set(entries);
    } catch (err) {
      this.log.error("Failed to persist terminals", { error: String(err) });
    }
  }

  /**
   * Load persisted terminal entries from storage (written before a hot-reload).
   */
  private async loadPersistedTerminals(): Promise<PersistedTerminalEntry[]> {
    if (!this.terminalsStore) return [];
    const data = await this.terminalsStore.get();
    return data ?? [];
  }

  /**
   * Reconcile persisted session records against actual wezterm state.
   * Three phases:
   *   1. Recover persisted terminals (re-adopt PIDs that are still alive)
   *   2. Orphan scan via pgrep — match by port from persisted session data
   *   3. Multiplexer state sync (mark sessions inactive if workspace is gone)
   */
  private async reconcileSessions(): Promise<void> {
    // --- Phase 1: Recover persisted terminals ---
    const persisted = await this.loadPersistedTerminals();
    if (persisted.length > 0) {
      this.log.info("Recovering persisted terminals", {
        count: persisted.length,
      });
      for (const entry of persisted) {
        if (isProcessAlive(entry.pid)) {
          this.ttydPids.set(entry.sessionId, entry.pid);
          this.ttydPorts.set(entry.sessionId, entry.port);
          this.log.info("Re-adopted ttyd process", {
            sessionId: entry.sessionId,
            pid: entry.pid,
            port: entry.port,
          });
        } else {
          this.log.info("Persisted ttyd process is dead, skipping", {
            sessionId: entry.sessionId,
            pid: entry.pid,
          });
        }
      }
      // Clean up persisted data after recovery
      try {
        await this.terminalsStore?.delete();
      } catch {
        /* ignore */
      }
    }

    // --- Phase 2: Orphan scan via pgrep ---
    if (!isWindows()) {
      try {
        const pgrepResult = Bun.spawnSync(["pgrep", "-a", "ttyd"], {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
        });
        const raw = pgrepResult.stdout.toString().trim();

        if (raw) {
          // Build a reverse lookup: port -> sessionId from sessions that have terminal info
          const sessions = await this.loadSessions();
          const portToSession = new Map<number, string>();
          for (const session of sessions) {
            if (session.terminal?.port) {
              portToSession.set(session.terminal.port, session.id);
            }
          }

          for (const line of raw.split("\n")) {
            const parts = line.trim().split(/\s+/);
            const pid = parseInt(parts[0] ?? "0", 10);
            if (!pid) continue;

            // Skip already-tracked
            if ([...this.ttydPids.values()].includes(pid)) continue;

            // Extract port from command line
            const portIdx = parts.indexOf("--port");
            const port =
              portIdx !== -1 ? parseInt(parts[portIdx + 1] ?? "0", 10) : 0;
            if (!port) continue;

            // Match by port to a known session
            const sessionId = portToSession.get(port);
            if (sessionId && !this.ttydPids.has(sessionId)) {
              this.ttydPids.set(sessionId, pid);
              this.ttydPorts.set(sessionId, port);
              this.log.info("Recovered orphaned ttyd process by port match", {
                sessionId,
                pid,
                port,
              });
            }
          }
        }
      } catch {
        // pgrep returns non-zero when no processes found — that's fine
      }
    }

    // --- Phase 3: Multiplexer state sync ---
    const sessions = await this.loadSessions();
    let changed = false;

    for (const session of sessions) {
      if (session.status === "terminated") continue;

      const workspaceName = this.getWorkspaceName(session);
      const exists = this.workspaceExists(workspaceName);

      if (!exists && session.status === "active") {
        session.status = "inactive";
        session.updatedAt = nowISO();
        session.terminal = undefined;
        changed = true;
        this.log.info("Reconciled stale session as inactive", {
          id: session.id,
          name: session.name,
        });
      }
    }

    if (changed) {
      await this.saveSessions(sessions);
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

/**
 * Module-level provider singleton — wezterm-mux-server is a global OS
 * resource and we must not spawn duplicate mux servers per profile.
 * The factory binds to this provider on first call and reuses it.
 */
const provider = new WeztermSessionProvider();

// Cross-platform binary discovery via Bun.which (handles PATHEXT on Windows).
// NOTE: Bun.which snapshots PATH at process start, so callers that need to
// detect a freshly-installed binary MUST pass `{ PATH: process.env.PATH }`.
function whichSync(bin: string): string | null {
  return Bun.which(bin) ?? null;
}

// Re-check after an install: Bun.which caches the process-start PATH, so an
// explicit PATH override is required to see binaries added during this run.
function whichLive(bin: string): string | null {
  return Bun.which(bin, { PATH: process.env.PATH }) ?? null;
}

interface PrereqInstallResult {
  ok: boolean;
  installed: string[];
  pendingSudo: { name: string; command: string; reason: string }[];
  errors: { name: string; message: string }[];
}

const WEZTERM_REASON = "wezterm is required for the WezTerm session backend.";

/**
 * Run a package-manager install command and report success only when the
 * binary actually becomes resolvable afterwards. The manager binary itself
 * is guarded by the caller via `Bun.which`.
 */
function runInstaller(command: string[]): boolean {
  const result = Bun.spawnSync(command, {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 300_000,
  });
  return result.exitCode === 0;
}

/**
 * Attempt to install wezterm without sudo on the current platform.
 *
 * - win32: winget → scoop → choco (all non-elevated user installs).
 * - darwin: `brew install --cask wezterm`.
 * - linux: no non-sudo path is attempted inline; the caller returns a
 *   `pendingSudo` entry instead so the agent can surface the command.
 *
 * Returns `true` when wezterm is resolvable after the attempt.
 */
function installWezterm(result: PrereqInstallResult): void {
  const platform = process.platform;

  if (platform === "win32") {
    if (whichSync("winget")) {
      runInstaller([
        "winget",
        "install",
        "--id",
        "wez.wezterm",
        "-e",
        "--accept-source-agreements",
        "--accept-package-agreements",
      ]);
      if (whichLive("wezterm")) {
        result.installed.push("wezterm");
        return;
      }
    }
    if (whichSync("scoop")) {
      runInstaller(["scoop", "bucket", "add", "extras"]);
      runInstaller(["scoop", "install", "wezterm"]);
      if (whichLive("wezterm")) {
        result.installed.push("wezterm");
        return;
      }
    }
    if (whichSync("choco")) {
      runInstaller(["choco", "install", "wezterm", "-y"]);
      if (whichLive("wezterm")) {
        result.installed.push("wezterm");
        return;
      }
    }
    result.errors.push({
      name: "wezterm",
      message:
        "Could not auto-install wezterm — no usable winget/scoop/choco found or the install failed. " +
        "Install manually: https://wezfurlong.org/wezterm/install/windows.html",
    });
    return;
  }

  if (platform === "darwin") {
    if (whichSync("brew")) {
      runInstaller(["brew", "install", "--cask", "wezterm"]);
      if (whichLive("wezterm")) {
        result.installed.push("wezterm");
        return;
      }
    }
    result.errors.push({
      name: "wezterm",
      message:
        "Could not auto-install wezterm via Homebrew. " +
        "Install Homebrew (https://brew.sh) then run `brew install --cask wezterm`, " +
        "or follow https://wezfurlong.org/wezterm/install/macos.html",
    });
    return;
  }

  // linux (and any other POSIX) — do not run sudo inline; surface a command.
  result.pendingSudo.push({
    name: "wezterm",
    command:
      "Install wezterm from your distro package manager or the official " +
      "repository — see https://wezfurlong.org/wezterm/install/linux.html",
    reason: WEZTERM_REASON,
  });
}

/**
 * Prereqs router — this plugin OWNS installing the `wezterm` binary so the
 * agent never has to. Shape matches the agent's prereqs protocol.
 */
function createPrereqsRoutes() {
  return new Elysia({ prefix: "/prereqs" })
    .get("/status", () => {
      const missing = whichSync("wezterm")
        ? []
        : [
            {
              name: "wezterm",
              kind: "binary" as const,
              requiresSudo: false,
            },
          ];
      return { satisfied: missing.length === 0, missing };
    })
    .post("/install", () => {
      const result: PrereqInstallResult = {
        ok: true,
        installed: [],
        pendingSudo: [],
        errors: [],
      };
      if (whichSync("wezterm")) {
        return result;
      }
      installWezterm(result);
      result.ok = result.errors.length === 0;
      return result;
    })
    .post("/uninstall", () => ({ ok: true }));
}

/**
 * Plugin contract V2 factory. Builds a fresh VibePlugin (with its own
 * lifecycle/telemetry instances) per call. The `provider` module-level
 * binding is reused because wezterm-mux-server is a global OS resource.
 */
export const createPlugin: VibePluginFactory = (
  _ctx: ProfileContext,
): VibePlugin => {
  // Lifecycle hooks via SDK — auto-emits `<plugin>.ready` telemetry,
  // delegates to provider. WezTerm ships official Windows builds with a
  // native multiplexer, so this plugin is the default Windows session
  // backend and initializes on every platform (no skipped platforms).
  const lifecycle = createLifecycleHooks({
    name: PLUGIN_NAME,
    skipPlatforms: [],
    telemetryEventName: `${PLUGIN_NAME}.ready`,
    onInit: async (services: HostServices) => {
      new ProviderRegistry(services).registerProvider(
        "session",
        PROVIDER_NAME,
        provider,
      );
      new TelemetryEmitter(PLUGIN_NAME, PLUGIN_VERSION, services).emit(
        "session.provider.ready",
        { provider: "wezterm" },
      );
      await provider.init(services);
    },
    onShutdown: async () => {
      await provider.shutdown({ reason: "shutdown" });
    },
  });

  const plugin: VibePlugin = {
    capabilities: {
      storage: "rw",
      subprocess: true,
      telemetry: true,
    },
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    description:
      "WezTerm + ttyd session provider — manages terminal sessions via WezTerm workspaces and exposes web terminals via ttyd",
    tags: ["backend", "provider"],
    apiPrefix: "/api/session-wezterm",

    prerequisites: [
      {
        name: "wezterm",
        kind: "binary",
        requiresSudo: false,
      },
    ],

    createRoutes: () => createPrereqsRoutes(),
    onServerStart: lifecycle.onServerStart,
    onServerStop: lifecycle.onServerStop,
  };

  return plugin;
};

export type {
  SessionProvider,
  SessionProviderCapabilities,
  SessionConfig,
  SessionInfo,
  SessionStatus,
  TerminalInfo,
  HealthCheckResult,
  SystemSessionInfo,
  SystemTerminalInfo,
};
