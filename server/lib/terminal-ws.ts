/**
 * WebSocket Terminal — real shell sessions connected to project directories.
 *
 * When a client connects to /ws/terminal/:sessionId, we spawn a bash shell
 * with cwd set to the project path and pipe stdin/stdout/stderr bidirectionally.
 *
 * Falls back to spawn (no PTY) if node-pty is unavailable.
 */
import type http from "http";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { projectStore } from "../storage.js";

// We use placeholders until ws is loaded. setupTerminalWs loads it lazily.
let WebSocketServer: any = null;
let WebSocket: any = { OPEN: 1 }; // Fallback constant

interface TerminalSession {
  sessionId: string;
  projectId: number;
  cwd: string; // Working directory for the shell
  ws: any; // WebSocket instance (typed as any since ws is dynamically loaded)
  process: ChildProcessWithoutNullStreams | any; // pty or spawn child
  createdAt: string;
}

// Active sessions map: sessionId → session
const activeSessions = new Map<string, TerminalSession>();

// Active sessions by projectId for REST API listing
const sessionsByProject = new Map<number, Set<string>>();

// Pending sessions (created via POST but not yet WebSocket-connected)
const pendingSessions = new Map<string, { projectId: number; cwd: string }>();

/**
 * Create a new terminal session for a project.
 * Returns the sessionId.
 */
export function createTerminalSession(projectId: number, cwd?: string): { sessionId: string; cwd: string } {
  const sessionId = `term-${projectId}-${Date.now()}`;

  // We just track it — the WS connection will start the actual process
  const project = projectStore.getById(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);

  // Use provided cwd, fall back to project path
  const sessionCwd = cwd || project.path;

  // Store the pending session so handleTerminalConnection can find the cwd
  pendingSessions.set(sessionId, { projectId, cwd: sessionCwd });

  // Register the session in the by-project map
  if (!sessionsByProject.has(projectId)) {
    sessionsByProject.set(projectId, new Set());
  }
  sessionsByProject.get(projectId)!.add(sessionId);

  console.log(`[Terminal] Created session ${sessionId} for project ${project.name}, cwd=${sessionCwd}`);
  return { sessionId, cwd: sessionCwd };
}

/**
 * List active terminal sessions for a project.
 */
export function listTerminalSessions(projectId: number): { sessionId: string; projectId: number; createdAt: string }[] {
  const ids = sessionsByProject.get(projectId) || new Set();
  const sessions: { sessionId: string; projectId: number; createdAt: string }[] = [];

  for (const id of ids) {
    const session = activeSessions.get(id);
    if (session && session.ws.readyState === WebSocket.OPEN) {
      sessions.push({ sessionId: id, projectId, createdAt: session.createdAt });
    } else {
      // Clean up dead sessions from the set
      ids.delete(id);
    }
  }

  return sessions;
}

/**
 * Set up the WebSocket server for terminal connections.
 * Handles /ws/terminal/:sessionId paths.
 */
export function setupTerminalWs(httpServer: http.Server): void {
  // Load ws lazily so startup doesn't fail if ws isn't installed yet
  try {
    // Node ESM projects need createRequire or dynamic import.
    // We use a synchronous import via the compiled CJS path.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const wsModule = (globalThis as any).__wsModule ||
      (() => { try { return eval('require')("ws"); } catch { return null; } })();
    if (wsModule) {
      WebSocketServer = wsModule.WebSocketServer;
      WebSocket = wsModule.WebSocket;
      (globalThis as any).__wsModule = wsModule;
    }
  } catch { /* ws not available */ }

  if (!WebSocketServer) {
    console.warn("[Terminal] 'ws' package not installed — terminal WebSocket unavailable. Add 'ws' to package.json and run npm install.");
    return;
  }

  const wss = new WebSocketServer({ noServer: true });

  // Upgrade HTTP connections to WebSocket for terminal paths
  httpServer.on("upgrade", (req, socket, head) => {
    const url = req.url || "";
    const match = url.match(/^\/ws\/terminal\/([^/?]+)/);
    if (!match) return; // Not a terminal request — ignore

    wss.handleUpgrade(req, socket as any, head, (ws: any) => {
      wss.emit("connection", ws, req, match[1]);
    });
  });

  wss.on("connection", (ws: any, req: http.IncomingMessage, sessionId: string) => {
    handleTerminalConnection(ws, sessionId);
  });

  console.log("[Terminal] WebSocket server initialized at /ws/terminal/:sessionId");
}

function handleTerminalConnection(ws: any, sessionId: string): void {
  // Look up session info from pendingSessions (created via POST /terminal/sessions)
  const pending = pendingSessions.get(sessionId);

  let projectId: number;
  let sessionCwd: string;

  if (pending) {
    projectId = pending.projectId;
    sessionCwd = pending.cwd;
    pendingSessions.delete(sessionId);
  } else {
    // Fallback: parse project ID from session ID format term-{projectId}-{timestamp}
    const match = sessionId.match(/^term-(\d+)-/);
    if (!match) {
      ws.send(JSON.stringify({ type: "error", message: `Invalid session ID: ${sessionId}` }));
      ws.close();
      return;
    }
    projectId = parseInt(match[1]);
    const project = projectStore.getById(projectId);
    if (!project) {
      ws.send(JSON.stringify({ type: "error", message: `Project ${projectId} not found` }));
      ws.close();
      return;
    }
    sessionCwd = project.path;
  }

  const project = projectStore.getById(projectId);
  const projectName = project?.name || `project-${projectId}`;

  console.log(`[Terminal] New connection: sessionId=${sessionId}, project=${projectName}, cwd=${sessionCwd}`);

  // Try to use node-pty for full PTY support; fall back to spawn
  let proc: any;
  let isPty = false;

  try {
    // Dynamic require for optional node-pty
    const pty = require("node-pty");
    proc = pty.spawn("bash", [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: sessionCwd,
      env: {
        ...process.env,
        HOME: process.env.HOME || "/root",
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      },
    });
    isPty = true;
    console.log(`[Terminal] Using node-pty for session ${sessionId}`);
  } catch {
    // Fallback: use spawn with pipes
    proc = spawn("bash", [], {
      cwd: sessionCwd,
      env: {
        ...process.env,
        HOME: process.env.HOME || "/root",
        TERM: "xterm-256color",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    console.log(`[Terminal] Using spawn (no PTY) for session ${sessionId}`);
  }

  // Store session
  const session: TerminalSession = {
    sessionId,
    projectId,
    cwd: sessionCwd,
    ws,
    process: proc,
    createdAt: new Date().toISOString(),
  };
  activeSessions.set(sessionId, session);

  // Notify client that session is ready
  ws.send(JSON.stringify({ type: "ready", sessionId, projectPath: sessionCwd, isPty }));

  // Route process output → WebSocket
  if (isPty) {
    proc.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "output", data }));
      }
    });

    proc.onExit(({ exitCode }: { exitCode: number }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "exit", exitCode }));
        ws.close();
      }
      cleanupSession(sessionId, projectId);
    });
  } else {
    proc.stdout?.on("data", (data: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "output", data: data.toString() }));
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "output", data: data.toString() }));
      }
    });

    proc.on("close", (code: number | null) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "exit", exitCode: code }));
        ws.close();
      }
      cleanupSession(sessionId, projectId);
    });

    proc.on("error", (err: Error) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "error", message: err.message }));
        ws.close();
      }
      cleanupSession(sessionId, projectId);
    });
  }

  // Route WebSocket messages → process stdin
  ws.on("message", (rawMessage: Buffer | string) => {
    let msg: any;
    try {
      msg = JSON.parse(rawMessage.toString());
    } catch {
      // Raw input — send directly to stdin
      try {
        if (isPty) proc.write(rawMessage.toString());
        else proc.stdin?.write(rawMessage.toString());
      } catch { /* process may be dead */ }
      return;
    }

    switch (msg.type) {
      case "input":
        try {
          if (isPty) proc.write(msg.data);
          else proc.stdin?.write(msg.data);
        } catch { /* process dead */ }
        break;

      case "resize":
        if (isPty && typeof msg.cols === "number" && typeof msg.rows === "number") {
          try { proc.resize(msg.cols, msg.rows); } catch { /* ignore */ }
        }
        break;

      case "kill":
        try {
          if (isPty) proc.kill();
          else proc.kill("SIGTERM");
        } catch { /* ignore */ }
        break;
    }
  });

  // Cleanup on WebSocket close
  ws.on("close", () => {
    console.log(`[Terminal] WebSocket closed for session ${sessionId}`);
    try {
      if (isPty) proc.kill();
      else proc.kill("SIGTERM");
    } catch { /* already dead */ }
    cleanupSession(sessionId, projectId);
  });

  ws.on("error", (err: any) => {
    console.warn(`[Terminal] WebSocket error for session ${sessionId}:`, err.message);
  });
}

function cleanupSession(sessionId: string, projectId: number): void {
  activeSessions.delete(sessionId);
  sessionsByProject.get(projectId)?.delete(sessionId);
}
