/**
 * Code Execution Tool — Docker-based sandboxed code runner
 * Spawns ephemeral containers for safe code execution
 */
import { registerTool, type ToolResult, type ToolContext } from "./registry.js";
import { dockerManager } from "../docker/manager.js";

registerTool("execute_code", {
  category: "code",
  definition: {
    type: "function",
    function: {
      name: "execute_code",
      description: "Execute code in a sandboxed Docker container. Supports Python, JavaScript/Node.js, Bash, and other languages. Returns stdout, stderr, and exit code. Use this to run computations, test code, process data, or build projects.",
      parameters: {
        type: "object",
        properties: {
          language: {
            type: "string",
            enum: ["python", "javascript", "bash", "typescript", "rust", "go", "c", "cpp"],
            description: "Programming language to execute",
          },
          code: { type: "string", description: "The code to execute" },
          timeout: { type: "number", description: "Timeout in seconds (default 120, max 600)" },
          packages: {
            type: "array",
            items: { type: "string" },
            description: "Packages to install before execution (e.g., ['numpy', 'pandas'] for Python)",
          },
        },
        required: ["language", "code"],
      },
    },
  },
  async execute(args, context): Promise<ToolResult> {
    const { language, code, timeout = 120, packages = [] } = args;

    try {
      const result = await dockerManager.executeCode({
        language,
        code,
        timeout: Math.min(timeout, 600),
        packages,
        requestId: context.requestId,
      });

      let output = "";
      if (result.stdout) output += `STDOUT:\n${result.stdout}\n`;
      if (result.stderr) output += `STDERR:\n${result.stderr}\n`;
      output += `\nExit code: ${result.exitCode}`;
      if (result.timedOut) output += "\n⚠ Execution timed out";

      return {
        success: result.exitCode === 0 && !result.timedOut,
        output: output.trim(),
        metadata: { exitCode: result.exitCode, timedOut: result.timedOut },
      };
    } catch (err: any) {
      return { success: false, output: `Code execution failed: ${err.message}` };
    }
  },
});

registerTool("shell_command", {
  category: "code",
  definition: {
    type: "function",
    function: {
      name: "shell_command",
      description: "Execute a shell command in a sandboxed Docker container. Useful for file operations, system commands, installing software, and running build tools.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute" },
          workdir: { type: "string", description: "Working directory inside the container (default /workspace)" },
          timeout: { type: "number", description: "Timeout in seconds (default 120)" },
        },
        required: ["command"],
      },
    },
  },
  async execute(args, context): Promise<ToolResult> {
    const { command, workdir = "/workspace", timeout = 120 } = args;

    try {
      const result = await dockerManager.executeCode({
        language: "bash",
        code: command,
        timeout: Math.min(timeout, 600),
        packages: [],
        requestId: context.requestId,
        workdir,
      });

      let output = "";
      if (result.stdout) output += result.stdout;
      if (result.stderr) output += `\n${result.stderr}`;
      output += `\nExit code: ${result.exitCode}`;

      return {
        success: result.exitCode === 0,
        output: output.trim(),
        metadata: { exitCode: result.exitCode },
      };
    } catch (err: any) {
      return { success: false, output: `Shell command failed: ${err.message}` };
    }
  },
});
