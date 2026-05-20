/**
 * Edit File Tool — Targeted find-and-replace for workspace files
 *
 * More efficient than rewriting entire files. Applies multiple
 * text replacements in a single call, saving tokens and reducing errors.
 * Uses native filesystem operations (NOT Docker).
 */
import { registerTool, type ToolResult, type ToolContext } from "./registry.js";
import fs from "fs";
import path from "path";

// Workspace root — all file operations are relative to this
const WORKSPACE_DIR = path.join(process.cwd(), "workspace");

/**
 * Resolve and validate a file path. Ensures the path is within the workspace.
 * Returns the absolute path or throws if the path tries to escape.
 */
function resolveSafePath(filePath: string): string {
  // Strip leading /workspace prefix if present (models often include it)
  let cleaned = filePath;
  if (cleaned.startsWith("/workspace/")) {
    cleaned = cleaned.slice("/workspace/".length);
  } else if (cleaned.startsWith("/workspace")) {
    cleaned = cleaned.slice("/workspace".length);
  }
  // Also handle relative paths
  if (cleaned.startsWith("/")) {
    cleaned = cleaned.slice(1);
  }

  const resolved = path.resolve(WORKSPACE_DIR, cleaned);

  // Security: ensure resolved path is within workspace
  if (!resolved.startsWith(WORKSPACE_DIR)) {
    throw new Error(`Path escapes workspace: ${filePath}`);
  }

  return resolved;
}

registerTool("edit_file", {
  category: "file",
  definition: {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Edit a file by replacing specific text. More efficient than rewriting entire files. Supports multiple replacements in one call.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to /workspace" },
          replacements: {
            type: "array",
            items: {
              type: "object",
              properties: {
                old_text: { type: "string", description: "Exact text to find (must match exactly)" },
                new_text: { type: "string", description: "Text to replace it with" },
              },
              required: ["old_text", "new_text"],
            },
            description: "Array of {old_text, new_text} replacements to apply",
          },
        },
        required: ["path", "replacements"],
      },
    },
  },
  async execute(args, context): Promise<ToolResult> {
    const { path: filePath, replacements } = args;

    if (!Array.isArray(replacements) || replacements.length === 0) {
      return { success: false, output: "Edit failed: replacements must be a non-empty array." };
    }

    try {
      const absPath = resolveSafePath(filePath);

      if (!fs.existsSync(absPath)) {
        return { success: false, output: `File not found: ${filePath}` };
      }

      const stat = fs.statSync(absPath);
      if (stat.isDirectory()) {
        return { success: false, output: `Path is a directory, not a file: ${filePath}` };
      }

      let content = fs.readFileSync(absPath, "utf-8");

      let applied = 0;
      const failures: string[] = [];

      for (let i = 0; i < replacements.length; i++) {
        const { old_text, new_text } = replacements[i];

        if (typeof old_text !== "string" || typeof new_text !== "string") {
          failures.push(`Replacement #${i + 1}: old_text and new_text must both be strings`);
          continue;
        }

        if (!content.includes(old_text)) {
          failures.push(
            `Replacement #${i + 1}: old_text not found in file — "${old_text.slice(0, 80)}${old_text.length > 80 ? "…" : ""}"`
          );
          continue;
        }

        // Count occurrences — warn if old_text matches more than once so the agent
        // can provide a more specific match string if needed.
        const occurrences = content.split(old_text).length - 1;
        if (occurrences > 1) {
          // Replace ALL occurrences and note it in the output
          content = content.split(old_text).join(new_text);
          applied++;
          failures.push(
            `Replacement #${i + 1}: WARNING — old_text matched ${occurrences} times, all were replaced. Use a more specific string if only one occurrence was intended.`
          );
        } else {
          content = content.replace(old_text, new_text);
          applied++;
        }
      }

      // Only write back if at least one replacement succeeded
      if (applied > 0) {
        fs.writeFileSync(absPath, content, "utf-8");
      }

      const total = replacements.length;
      const displayPath = `/workspace/${filePath.replace(/^\/workspace\/?/, "")}`;

      if (failures.length === 0) {
        return {
          success: true,
          output: `Applied ${applied}/${total} replacements to ${displayPath}`,
        };
      }

      const failureDetails = failures.join("\n");
      if (applied === 0) {
        return {
          success: false,
          output: `Applied 0/${total} replacements to ${displayPath}. All replacements failed:\n${failureDetails}`,
        };
      }

      return {
        success: true,
        output: `Applied ${applied}/${total} replacements to ${displayPath}. ${failures.length} failed:\n${failureDetails}`,
      };
    } catch (err: any) {
      return { success: false, output: `Edit failed: ${err.message}` };
    }
  },
});
