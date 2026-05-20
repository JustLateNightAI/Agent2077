/**
 * Session Search — FTS5-powered cross-session search for Agent2077.
 * Enables the agent to find relevant information from past conversations.
 */
import { registerTool, type ToolResult } from "./registry.js";
import { getDb } from "../db.js";

registerTool("session_search", {
  category: "memory",
  requiresApproval: false,
  definition: {
    type: "function",
    function: {
      name: "session_search",
      description:
        "Search across all past conversation sessions using full-text search. " +
        "Returns matching messages with conversation context. " +
        "Use this to recall information from previous sessions — things the user mentioned, " +
        "decisions made, code discussed, etc.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description: "Natural language search query. Use specific keywords rather than full sentences for best results.",
          },
          limit: {
            type: "number",
            description: "Maximum number of results to return (default 10, max 50).",
          },
        },
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    try {
      const query = args.query as string;
      const limit = Math.min(Math.max((args.limit as number) || 10, 1), 50);

      const rawDb = getDb();

      const results = rawDb.prepare(`
        SELECT 
          m.id,
          m.conversation_id as conversationId,
          m.role,
          m.content,
          m.created_at as createdAt,
          rank
        FROM messages_fts
        JOIN messages m ON m.id = messages_fts.rowid
        WHERE messages_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(query, limit) as any[];

      if (results.length === 0) {
        return { success: true, output: `No results found for "${query}".` };
      }

      // Group by conversation
      const byConv = new Map<number, any[]>();
      for (const r of results) {
        if (!byConv.has(r.conversationId)) byConv.set(r.conversationId, []);
        byConv.get(r.conversationId)!.push(r);
      }

      let output = `Found ${results.length} result(s) across ${byConv.size} conversation(s) for "${query}":\n\n`;
      for (const [convId, msgs] of byConv) {
        output += `── Conversation #${convId} ──\n`;
        for (const msg of msgs) {
          const time = new Date(msg.createdAt).toLocaleString();
          const preview = msg.content.slice(0, 300);
          output += `  [${msg.role}] (${time}): ${preview}${msg.content.length > 300 ? "..." : ""}\n`;
        }
        output += "\n";
      }

      return { success: true, output: output.trim() };
    } catch (e: any) {
      // FTS5 might not be populated yet if no messages exist
      if (e.message?.includes("no such table")) {
        return { success: true, output: "Session search is not yet available — no searchable messages exist." };
      }
      return { success: false, output: `session_search error: ${e.message}` };
    }
  },
});
