/**
 * Web Search Tool — SearXNG integration
 */
import { registerTool, type ToolResult, type ToolContext } from "./registry.js";
import { settingsStore } from "../storage.js";

registerTool("web_search", {
  category: "search",
  definition: {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web using SearXNG. Returns a list of results with titles, URLs, and snippets. Use this to find current information, answer factual questions, or research topics.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" },
          num_results: { type: "number", description: "Number of results to return (default 5, max 20)" },
        },
        required: ["query"],
      },
    },
  },
  async execute(args: { query: string; num_results?: number }, context: ToolContext): Promise<ToolResult> {
    // Internet Kill Switch
    const internetEnabled = settingsStore.get("internetEnabled");
    if (internetEnabled === "false") {
      return { success: false, output: "Internet access is disabled (Kill Switch is ON). The agent cannot access the internet. Proceed using only local knowledge and tools." };
    }
    const searxngUrl = settingsStore.get("searxng.url") || "http://localhost:8888";
    const enabled = settingsStore.get("searxng.enabled");
    if (enabled !== "true") {
      return { success: false, output: "Web search is currently disabled (SearXNG not configured). You can complete this task using your own knowledge instead. Do NOT call web_search again — it will fail. Proceed with the task using what you know." };
    }

    const numResults = Math.min(args.num_results || 5, 20);

    try {
      const url = `${searxngUrl}/search?q=${encodeURIComponent(args.query)}&format=json&count=${numResults}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`SearXNG returned ${res.status}`);

      const data = await res.json();
      const results = (data.results || []).slice(0, numResults).map((r: any, i: number) => ({
        index: i + 1,
        title: r.title,
        url: r.url,
        snippet: r.content?.slice(0, 300) || "",
      }));

      if (results.length === 0) {
        return { success: true, output: `No results found for "${args.query}"` };
      }

      const text = results.map((r: any) =>
        `[${r.index}] ${r.title}\n    ${r.url}\n    ${r.snippet}`
      ).join("\n\n");

      return {
        success: true,
        output: `Found ${results.length} results for "${args.query}":\n\n${text}`,
        metadata: { results },
      };
    } catch (err: any) {
      return { success: false, output: `Search failed: ${err.message}` };
    }
  },
});

registerTool("fetch_url", {
  category: "search",
  definition: {
    type: "function",
    function: {
      name: "fetch_url",
      description: "Fetch the text content of a URL. Useful for reading web pages, documentation, or API responses.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to fetch" },
          max_length: { type: "number", description: "Maximum characters to return (default 10000)" },
        },
        required: ["url"],
      },
    },
  },
  async execute(args: { url: string; max_length?: number }, context: ToolContext): Promise<ToolResult> {
    // Internet Kill Switch
    const internetEnabled = settingsStore.get("internetEnabled");
    if (internetEnabled === "false") {
      return { success: false, output: "Internet access is disabled (Kill Switch is ON). The agent cannot access the internet. Proceed using only local knowledge and tools." };
    }
    const maxLen = args.max_length || 10000;
    try {
      const res = await fetch(args.url, {
        signal: AbortSignal.timeout(15000),
        headers: { "User-Agent": "Agent2077/1.0" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const json = await res.json();
        const text = JSON.stringify(json, null, 2).slice(0, maxLen);
        return { success: true, output: text };
      }

      const text = await res.text();
      // Strip HTML tags for readability
      const cleaned = text
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLen);

      return { success: true, output: cleaned || "(empty page)" };
    } catch (err: any) {
      return { success: false, output: `Fetch failed: ${err.message}` };
    }
  },
});
