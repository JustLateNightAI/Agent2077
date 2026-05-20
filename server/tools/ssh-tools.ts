/**
 * SSH Tools — Remote machine access via SSH
 * Executes commands on user-configured SSH targets by name.
 * Uses sshpass for password-based auth; targets stored in settingsStore under "ssh.targets"
 */
import { registerTool, type ToolResult } from "./registry.js";
import { settingsStore } from "../storage.js";
import { execSync } from "child_process";

export interface SshTarget {
  id: string;
  name: string;
  host: string;
  user: string;
  password: string;
  port: number;
}

function getTargets(): SshTarget[] {
  try {
    const raw = settingsStore.get("ssh.targets");
    if (!raw) return [];
    return JSON.parse(raw) as SshTarget[];
  } catch {
    return [];
  }
}

function resolveTarget(nameOrId: string): SshTarget | null {
  const targets = getTargets();
  // Try exact name match first (case-insensitive), then ID
  return (
    targets.find(t => t.name.toLowerCase() === nameOrId.toLowerCase()) ??
    targets.find(t => t.id === nameOrId) ??
    null
  );
}

// ── ssh_exec ────────────────────────────────────────────────────────────────

registerTool("ssh_exec", {
  category: "code",
  definition: {
    type: "function",
    function: {
      name: "ssh_exec",
      description:
        "Execute a shell command on a remote machine via SSH. " +
        "Specify the target by its configured name (e.g. 'DGX Spark') or ID. " +
        "Use ssh_list_targets to see available machines. " +
        "Returns stdout, stderr, and exit code from the remote command.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description:
              "Name or ID of the SSH target to connect to (e.g. 'DGX Spark'). " +
              "Names are case-insensitive.",
          },
          command: {
            type: "string",
            description: "Shell command to run on the remote machine.",
          },
          timeout: {
            type: "number",
            description: "Timeout in seconds before the command is killed (default 60, max 300).",
          },
        },
        required: ["target", "command"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const { target: targetRef, command, timeout = 60 } = args as {
      target: string;
      command: string;
      timeout?: number;
    };

    const target = resolveTarget(targetRef);
    if (!target) {
      const targets = getTargets();
      const names = targets.map(t => `"${t.name}"`).join(", ");
      return {
        success: false,
        output: `SSH target "${targetRef}" not found. Available targets: ${names || "(none configured — add targets in Settings → SSH Targets)"}`,
      };
    }

    const clampedTimeout = Math.min(Math.max(timeout, 5), 300);
    const port = target.port || 22;

    // Build the sshpass + ssh command
    // -o StrictHostKeyChecking=no  — skip host key prompt on first connect
    // -o ConnectTimeout=10         — don't hang forever if host unreachable
    // -o BatchMode=no              — needed for sshpass password injection
    const sshCmd = [
      "sshpass",
      `-p '${target.password.replace(/'/g, "'\\''")}'`,
      "ssh",
      "-o StrictHostKeyChecking=no",
      "-o ConnectTimeout=10",
      `-p ${port}`,
      `${target.user}@${target.host}`,
      `'${command.replace(/'/g, "'\\''")}'`,
    ].join(" ");

    try {
      const stdout = execSync(sshCmd, {
        timeout: clampedTimeout * 1000,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });

      return {
        success: true,
        output: `[${target.name} (${target.user}@${target.host}:${port})]\n${stdout || "(no output)"}`.trim(),
        metadata: { target: target.name, host: target.host, exitCode: 0 },
      };
    } catch (err: any) {
      // execSync throws on non-zero exit; err.stdout / err.stderr still available
      const stdout = err.stdout ?? "";
      const stderr = err.stderr ?? "";
      const exitCode = err.status ?? 1;

      if (err.signal === "SIGTERM" || err.code === "ETIMEDOUT") {
        return {
          success: false,
          output: `[${target.name}] Command timed out after ${clampedTimeout}s.\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`,
          metadata: { target: target.name, timedOut: true },
        };
      }

      // sshpass exit code 5 = auth failure
      if (exitCode === 5) {
        return {
          success: false,
          output: `[${target.name}] SSH authentication failed. Check the password in Settings → SSH Targets.\nSTDERR: ${stderr}`,
          metadata: { target: target.name, exitCode },
        };
      }

      let output = `[${target.name} (${target.user}@${target.host}:${port})] Exit code: ${exitCode}`;
      if (stdout) output += `\nSTDOUT:\n${stdout}`;
      if (stderr) output += `\nSTDERR:\n${stderr}`;

      return {
        success: exitCode === 0,
        output: output.trim(),
        metadata: { target: target.name, exitCode },
      };
    }
  },
});

// ── ssh_list_targets ─────────────────────────────────────────────────────────

registerTool("ssh_list_targets", {
  category: "code",
  definition: {
    type: "function",
    function: {
      name: "ssh_list_targets",
      description:
        "List all configured SSH targets (name, host, user, port). " +
        "Use this to discover available machines before calling ssh_exec.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  async execute(): Promise<ToolResult> {
    const targets = getTargets();
    if (targets.length === 0) {
      return {
        success: true,
        output: "No SSH targets configured. Add targets in Settings → SSH Targets.",
      };
    }

    const lines = targets.map(
      t => `- "${t.name}" → ${t.user}@${t.host}:${t.port || 22}`
    );
    return {
      success: true,
      output: `Configured SSH targets:\n${lines.join("\n")}`,
      metadata: { count: targets.length },
    };
  },
});
