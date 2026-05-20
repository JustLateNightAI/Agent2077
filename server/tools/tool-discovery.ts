/**
 * Tool Discovery — v16.73.1
 *
 * Lets the agent (and the user, via "what tools do you have?") browse the
 * full registered tool catalogue on demand, without dumping every schema
 * into the system prompt. This is the on-demand counterpart to the smart
 * tool selector: the selector trims what's sent each turn, while these
 * tools let the agent look up anything that didn't make the cut.
 *
 *  - tool_list:   compact index (name + category + one-line summary). Optional
 *                 category filter. Cheap output.
 *  - tool_search: substring/keyword match across name + description, with
 *                 optional category filter. Returns top N hits.
 *
 * Both tools are added to the selector's "floor" so they're always
 * available regardless of task type / model / cap.
 */
import { registerTool, getAllTools, type ToolResult } from "./registry.js";

const CATEGORY_HINT =
  "Optional category filter. One of: search, code, file, docker, system, memory, skill, self-dev, image.";

registerTool("tool_list", {
  category: "system",
  requiresApproval: false,
  maxResultSizeChars: 12000,
  definition: {
    type: "function",
    function: {
      name: "tool_list",
      description:
        "List all tools available in this Agent2077 install. Returns a compact index " +
        "(name, category, and a short description) for every registered tool. " +
        "Use this when the user asks what tools you have, or when you suspect a tool " +
        "exists that wasn't included in this turn's selected set. Optional `category` filter.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", description: CATEGORY_HINT },
        },
        required: [],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    try {
      const all = getAllTools();
      const catFilter = typeof args.category === "string" ? args.category.toLowerCase() : null;
      const byCategory = new Map<string, string[]>();
      let total = 0;

      for (const [name, handler] of all) {
        if (handler.checkFn && !handler.checkFn()) continue;
        const cat = (handler.category as string) || "other";
        if (catFilter && cat.toLowerCase() !== catFilter) continue;
        const desc = (handler.definition.function.description || "")
          .split(/\.\s|\n/)[0]
          .trim();
        const short = desc.length > 110 ? desc.slice(0, 107) + "..." : desc;
        const list = byCategory.get(cat) ?? [];
        list.push(`  - **${name}**: ${short}`);
        byCategory.set(cat, list);
        total++;
      }

      if (total === 0) {
        return { success: true, output: catFilter ? `No tools registered in category "${catFilter}".` : "No tools registered." };
      }

      const categories = Array.from(byCategory.keys()).sort();
      const sections = categories.map(c => `### ${c} (${byCategory.get(c)!.length})\n${byCategory.get(c)!.sort().join("\n")}`);
      const header = catFilter
        ? `${total} tool(s) in category "${catFilter}".`
        : `${total} tool(s) registered across ${categories.length} categories. Use tool_search to find a tool by keyword.`;
      return { success: true, output: `${header}\n\n${sections.join("\n\n")}` };
    } catch (e: any) {
      return { success: false, output: `tool_list error: ${e.message}` };
    }
  },
});

registerTool("tool_search", {
  category: "system",
  requiresApproval: false,
  maxResultSizeChars: 8000,
  definition: {
    type: "function",
    function: {
      name: "tool_search",
      description:
        "Search the tool catalogue by keyword. Matches against tool names AND " +
        "descriptions (case-insensitive substring). Returns up to `limit` hits " +
        "with full description and parameter summary. Use this when you suspect " +
        "a specific tool exists (e.g. 'screenshot', 'docker', 'comfyui') but " +
        "it wasn't pre-selected this turn.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keyword(s) to look for. Required." },
          category: { type: "string", description: CATEGORY_HINT },
          limit: { type: "number", description: "Max hits to return (default 10, max 30)." },
        },
        required: ["query"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    try {
      const q = String(args.query || "").trim().toLowerCase();
      if (!q) return { success: false, output: "tool_search: `query` is required." };
      const catFilter = typeof args.category === "string" ? args.category.toLowerCase() : null;
      const limit = Math.min(Math.max(parseInt(String(args.limit ?? 10), 10) || 10, 1), 30);

      const all = getAllTools();
      type Hit = { name: string; category: string; description: string; paramsSummary: string; score: number };
      const hits: Hit[] = [];

      for (const [name, handler] of all) {
        if (handler.checkFn && !handler.checkFn()) continue;
        const cat = (handler.category as string) || "other";
        if (catFilter && cat.toLowerCase() !== catFilter) continue;
        const desc = handler.definition.function.description || "";
        const haystackName = name.toLowerCase();
        const haystackDesc = desc.toLowerCase();
        let score = 0;
        if (haystackName === q) score += 100;
        if (haystackName.includes(q)) score += 50;
        if (haystackDesc.includes(q)) score += 20;
        // Also split the query into tokens for multi-word matches
        const tokens = q.split(/\s+/).filter(Boolean);
        if (tokens.length > 1) {
          let allTokensInDesc = true;
          for (const t of tokens) {
            if (!haystackDesc.includes(t) && !haystackName.includes(t)) {
              allTokensInDesc = false;
              break;
            }
          }
          if (allTokensInDesc) score += 30;
        }
        if (score === 0) continue;
        const props = handler.definition.function.parameters?.properties || {};
        const required = handler.definition.function.parameters?.required || [];
        const paramLines = Object.entries(props).map(([k, v]: [string, any]) => {
          const req = required.includes(k) ? " *required*" : "";
          return `    - ${k} (${v.type})${req}: ${v.description || ""}`;
        });
        hits.push({
          name,
          category: cat,
          description: desc,
          paramsSummary: paramLines.length > 0 ? paramLines.join("\n") : "    (no parameters)",
          score,
        });
      }

      hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
      const top = hits.slice(0, limit);

      if (top.length === 0) {
        return { success: true, output: `No tools match "${q}"${catFilter ? ` in category "${catFilter}"` : ""}.` };
      }

      const sections = top.map(h =>
        `### ${h.name}  [${h.category}]\n${h.description}\nParameters:\n${h.paramsSummary}`
      );
      const tail = hits.length > top.length ? `\n\n(${hits.length - top.length} more hit(s) not shown — narrow the query or raise \`limit\`.)` : "";
      return { success: true, output: `${top.length} of ${hits.length} match(es) for "${q}":\n\n${sections.join("\n\n")}${tail}` };
    } catch (e: any) {
      return { success: false, output: `tool_search error: ${e.message}` };
    }
  },
});
