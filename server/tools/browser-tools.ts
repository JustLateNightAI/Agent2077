/**
 * Browser / Web Browsing Tools
 *
 * Lightweight HTML fetching + content extraction using built-in Node.js.
 * No extra dependencies — strips HTML tags using regex.
 *
 * Tools:
 *  - browse_url    — fetch a URL and return readable text
 *  - browse_screenshot — note: requires Playwright/Puppeteer (not available without Docker)
 *  - browse_search  — search DuckDuckGo HTML endpoint
 *  - browse_extract — extract elements by CSS selector (regex-based)
 */
import { registerTool, type ToolResult } from "./registry.js";
import { settingsStore } from "../storage.js";
import https from "https";
import http from "http";
import { URL } from "url";

// ── Lightweight HTML utilities ───────────────────────────────────────

/**
 * Fetch a URL and return the raw HTML body as a string.
 * Follows up to 3 redirects. Returns { body, statusCode, finalUrl }.
 */
async function fetchHtml(
  url: string,
  options: { timeout?: number; headers?: Record<string, string>; maxRedirects?: number } = {}
): Promise<{ body: string; statusCode: number; finalUrl: string }> {
  const { timeout = 15000, headers = {}, maxRedirects = 3 } = options;

  return new Promise((resolve, reject) => {
    let redirectsLeft = maxRedirects;

    function doRequest(requestUrl: string) {
      let parsed: URL;
      try {
        parsed = new URL(requestUrl);
      } catch {
        return reject(new Error(`Invalid URL: ${requestUrl}`));
      }

      const isHttps = parsed.protocol === "https:";
      const lib = isHttps ? https : http;

      const reqOptions = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; Agent2077/1.0; +https://agent2077.local)",
          "Accept": "text/html,application/xhtml+xml,*/*",
          "Accept-Language": "en-US,en;q=0.9",
          ...headers,
        },
        timeout,
      };

      const req = lib.request(reqOptions, (res) => {
        // Follow redirects
        if (
          (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) &&
          res.headers.location &&
          redirectsLeft > 0
        ) {
          redirectsLeft--;
          const nextUrl = res.headers.location.startsWith("http")
            ? res.headers.location
            : `${parsed.protocol}//${parsed.host}${res.headers.location}`;
          res.resume(); // discard body
          doRequest(nextUrl);
          return;
        }

        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          resolve({ body, statusCode: res.statusCode || 200, finalUrl: requestUrl });
        });
        res.on("error", reject);
      });

      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error(`Request timed out after ${timeout}ms`)); });
      req.setTimeout(timeout);
      req.end();
    }

    doRequest(url);
  });
}

/**
 * Strip HTML tags and extract readable text.
 * Also removes scripts, styles, and nav elements.
 */
function extractText(html: string): string {
  // Remove <script> and <style> blocks entirely
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  // Convert block elements to newlines
  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/td>/gi, "\t")
    .replace(/<\/th>/gi, "\t");

  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, " ");

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&#\d+;/g, "");

  // Normalize whitespace
  text = text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}

/**
 * Extract text content of all elements matching a CSS class or tag.
 * Simple regex-based — handles id="...", class="...", tag names.
 */
function extractBySelector(html: string, selector: string): string[] {
  const results: string[] = [];

  // Support simple selectors: tagname, #id, .class, tag.class
  let pattern: RegExp;

  if (selector.startsWith("#")) {
    // ID selector
    const id = selector.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    pattern = new RegExp(`<[^>]+id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/`, "gi");
  } else if (selector.startsWith(".")) {
    // Class selector
    const cls = selector.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    pattern = new RegExp(`<[^>]+class=["'][^"']*${cls}[^"']*["'][^>]*>([\\s\\S]*?)<\\/`, "gi");
  } else {
    // Tag selector
    const tag = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  }

  let match;
  while ((match = pattern.exec(html)) !== null) {
    const text = extractText(match[1]).trim();
    if (text) results.push(text);
    if (results.length >= 50) break; // Limit results
  }

  return results;
}

// ── Tool registrations ───────────────────────────────────────────────

// Tool: browse_url — fetch URL, return readable text
registerTool("browse_url", {
  category: "search",
  definition: {
    type: "function",
    function: {
      name: "browse_url",
      description: "Navigate to a URL and extract readable text content from the page. Returns the main text content, stripping scripts, styles, and navigation.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to browse (must start with http:// or https://)" },
          maxLength: { type: "number", description: "Maximum characters to return (default 8000)" },
        },
        required: ["url"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    // Internet Kill Switch
    const internetEnabled = settingsStore.get("internetEnabled");
    if (internetEnabled === "false") {
      return { success: false, output: "Internet access is disabled (Kill Switch is ON). The agent cannot access the internet. Proceed using only local knowledge and tools." };
    }
    try {
      const { body, statusCode, finalUrl } = await fetchHtml(args.url);
      const text = extractText(body);
      const maxLen = Math.min(parseInt(String(args.maxLength || 8000)), 20000);
      const truncated = text.length > maxLen ? text.slice(0, maxLen) + "\n...(truncated)" : text;
      return {
        success: true,
        output: `URL: ${finalUrl}\nStatus: ${statusCode}\n\n${truncated}`,
        metadata: { url: finalUrl, statusCode, length: text.length },
      };
    } catch (err: any) {
      return { success: false, output: `Failed to browse ${args.url}: ${err.message}` };
    }
  },
});

// Tool: browse_screenshot — placeholder noting Playwright requirement
registerTool("browse_screenshot", {
  category: "search",
  definition: {
    type: "function",
    function: {
      name: "browse_screenshot",
      description: "Take a screenshot of a web page or element. Note: requires Playwright which needs additional setup.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to screenshot" },
          selector: { type: "string", description: "Optional CSS selector to screenshot a specific element" },
        },
        required: ["url"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    // Internet Kill Switch
    const internetEnabled = settingsStore.get("internetEnabled");
    if (internetEnabled === "false") {
      return { success: false, output: "Internet access is disabled (Kill Switch is ON). The agent cannot access the internet. Proceed using only local knowledge and tools." };
    }
    // Check if playwright is available
    try {
      const { chromium } = await import("playwright").catch(() => { throw new Error("not installed"); });
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(args.url, { waitUntil: "networkidle", timeout: 30000 });

      let screenshotBuffer: Buffer;
      if (args.selector) {
        const element = await page.$(args.selector);
        if (!element) {
          await browser.close();
          return { success: false, output: `Selector "${args.selector}" not found on page` };
        }
        screenshotBuffer = await element.screenshot();
      } else {
        screenshotBuffer = await page.screenshot({ fullPage: false });
      }

      await browser.close();
      return {
        success: true,
        output: `Screenshot taken of ${args.url}${args.selector ? ` (selector: ${args.selector})` : ""}. Screenshot data: ${screenshotBuffer.length} bytes (base64: ${screenshotBuffer.toString("base64").slice(0, 100)}...)`,
        metadata: { url: args.url, selector: args.selector, size: screenshotBuffer.length },
      };
    } catch (err: any) {
      if (err.message === "not installed") {
        return {
          success: false,
          output: `Screenshot capability requires Playwright to be installed (npm install playwright && npx playwright install chromium). Install it in the project to enable screenshots. For now, use browse_url to get text content from the page.`,
        };
      }
      return { success: false, output: `Screenshot failed: ${err.message}` };
    }
  },
});

// Tool: browse_search — search DuckDuckGo HTML endpoint
registerTool("browse_search", {
  category: "search",
  definition: {
    type: "function",
    function: {
      name: "browse_search",
      description: "Search the web using DuckDuckGo (privacy-focused). Returns search results with titles, URLs, and snippets.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" },
          maxResults: { type: "number", description: "Maximum number of results to return (default 10)" },
        },
        required: ["query"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    // Internet Kill Switch
    const internetEnabled = settingsStore.get("internetEnabled");
    if (internetEnabled === "false") {
      return { success: false, output: "Internet access is disabled (Kill Switch is ON). The agent cannot access the internet. Proceed using only local knowledge and tools." };
    }
    try {
      const encodedQuery = encodeURIComponent(args.query);
      const { body } = await fetchHtml(
        `https://html.duckduckgo.com/html/?q=${encodedQuery}`,
        { headers: { "Accept-Language": "en-US,en;q=0.9" } }
      );

      // Parse DuckDuckGo HTML results
      const results: { title: string; url: string; snippet: string }[] = [];
      const maxResults = Math.min(parseInt(String(args.maxResults || 10)), 20);

      // Match result blocks — DuckDuckGo wraps each result in a div.result__body
      const resultBlocks = body.match(/<div class="result[^"]*"[\s\S]*?(?=<div class="result|<div class="nav-link|$)/g) || [];

      for (const block of resultBlocks.slice(0, maxResults)) {
        // Extract title
        const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)</);
        const title = titleMatch ? extractText(titleMatch[1]).trim() : "";

        // Extract URL
        const urlMatch = block.match(/href="([^"]+)"/);
        let url = urlMatch ? urlMatch[1] : "";
        // DuckDuckGo sometimes uses redirect URLs — try to extract the real URL
        if (url.includes("uddg=")) {
          const realUrl = url.match(/uddg=([^&]+)/);
          if (realUrl) url = decodeURIComponent(realUrl[1]);
        }
        if (url.startsWith("//")) url = "https:" + url;

        // Extract snippet
        const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
        const snippet = snippetMatch ? extractText(snippetMatch[1]).trim() : "";

        if (title || url) {
          results.push({ title, url, snippet });
        }
      }

      if (results.length === 0) {
        return { success: true, output: `No results found for: ${args.query}` };
      }

      const formatted = results
        .map((r, i) => `${i + 1}. **${r.title}**\n   URL: ${r.url}\n   ${r.snippet}`)
        .join("\n\n");

      return {
        success: true,
        output: `Search results for "${args.query}":\n\n${formatted}`,
        metadata: { query: args.query, resultCount: results.length },
      };
    } catch (err: any) {
      return { success: false, output: `Web search failed: ${err.message}` };
    }
  },
});

// Tool: browse_extract — extract elements by CSS selector
registerTool("browse_extract", {
  category: "search",
  definition: {
    type: "function",
    function: {
      name: "browse_extract",
      description: "Fetch a URL and extract specific elements by CSS selector (supports tag names, #id, .class selectors).",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to fetch" },
          selector: { type: "string", description: "CSS selector to extract (e.g. 'h1', '#main', '.content', 'p')" },
          maxResults: { type: "number", description: "Maximum number of matching elements to return (default 20)" },
        },
        required: ["url", "selector"],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    // Internet Kill Switch
    const internetEnabled = settingsStore.get("internetEnabled");
    if (internetEnabled === "false") {
      return { success: false, output: "Internet access is disabled (Kill Switch is ON). The agent cannot access the internet. Proceed using only local knowledge and tools." };
    }
    try {
      const { body, finalUrl } = await fetchHtml(args.url);
      const elements = extractBySelector(body, args.selector);
      const maxResults = Math.min(parseInt(String(args.maxResults || 20)), 50);
      const trimmed = elements.slice(0, maxResults);

      if (trimmed.length === 0) {
        return {
          success: true,
          output: `No elements found matching selector "${args.selector}" on ${finalUrl}`,
        };
      }

      const output = trimmed.map((el, i) => `[${i + 1}] ${el}`).join("\n\n");
      return {
        success: true,
        output: `Extracted ${trimmed.length} element(s) matching "${args.selector}" from ${finalUrl}:\n\n${output}`,
        metadata: { url: finalUrl, selector: args.selector, found: trimmed.length },
      };
    } catch (err: any) {
      return { success: false, output: `Failed to extract from ${args.url}: ${err.message}` };
    }
  },
});
