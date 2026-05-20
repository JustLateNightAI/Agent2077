import { registerTool, type ToolResult } from "./registry.js";
import fs from "fs";
import path from "path";
import { projectStore } from "../storage.js";

// In-memory pending edits store
interface PendingEdit {
  id: string;
  projectId: number;
  filePath: string;
  originalContent: string;
  proposedContent: string;
  status: "pending" | "approved" | "rejected";
  createdAt: number;
  description?: string;
}

export const pendingEdits = new Map<string, PendingEdit>();

// Clean up old pending edits (older than 10 minutes)
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, edit] of Array.from(pendingEdits)) {
    if (edit.createdAt < cutoff) pendingEdits.delete(id);
  }
}, 60000);

registerTool("propose_edit", {
  category: "file",
  definition: {
    type: "function",
    function: {
      name: "propose_edit",
      description:
        "Propose a file edit for user review. Shows a diff preview that the user can approve or reject. Use this instead of edit_file when working in a project workspace to let the user review changes first.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "number", description: "The project ID" },
          filePath: {
            type: "string",
            description: "File path relative to project root",
          },
          newContent: {
            type: "string",
            description: "The complete proposed new content for the file",
          },
          description: {
            type: "string",
            description: "Brief description of what this edit does",
          },
        },
        required: ["projectId", "filePath", "newContent"],
      },
    },
  },
  async execute(args, context): Promise<ToolResult> {
    const project = projectStore.getById(args.projectId as number);
    if (!project) {
      return { success: false, output: `Project ${args.projectId} not found` };
    }

    const fullPath = path.join(project.path, args.filePath as string);
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(project.path))) {
      return { success: false, output: "Path traversal not allowed" };
    }

    const originalContent = fs.existsSync(fullPath)
      ? fs.readFileSync(fullPath, "utf-8")
      : "";
    const editId = `edit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const pending: PendingEdit = {
      id: editId,
      projectId: args.projectId as number,
      filePath: args.filePath as string,
      originalContent,
      proposedContent: args.newContent as string,
      status: "pending",
      createdAt: Date.now(),
      description: args.description as string | undefined,
    };

    pendingEdits.set(editId, pending);

    // Send SSE event for diff preview
    if (context?.sseResponse) {
      const diffEvent = {
        type: "diff_preview",
        editId,
        filePath: args.filePath,
        original: originalContent.slice(0, 5000),
        proposed: (args.newContent as string).slice(0, 5000),
        description: args.description,
      };
      try {
        context.sseResponse.write(`data: ${JSON.stringify(diffEvent)}\n\n`);
      } catch {
        /* client disconnected */
      }
    }

    return {
      success: true,
      output: `Edit proposed for ${args.filePath} (ID: ${editId}). Waiting for user approval. Description: ${args.description || "No description"}`,
      metadata: {
        editId,
        filePath: args.filePath,
        status: "pending",
      },
    };
  },
});
