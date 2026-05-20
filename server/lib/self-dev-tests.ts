/**
 * Self-Dev Test Suite — automated tests against the dev server.
 * Each test makes HTTP requests and checks responses.
 */
import { DEV_PORT } from "./dev-workspace.js";

interface TestResult {
  name: string;
  category: string;
  passed: boolean;
  message: string;
  durationMs: number;
}

const BASE = `http://localhost:${DEV_PORT}`;

async function request(method: string, path: string, body?: any, headers?: Record<string, string>): Promise<{ status: number; body: any; raw: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: res.status, body: parsed, raw };
}

// Get auth token for testing
async function getAuthToken(): Promise<string | null> {
  try {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Agent2077", password: "Agent2077" }),
    });
    const setCookie = res.headers.get("set-cookie") || "";
    const match = setCookie.match(/agent2077_token=([^;]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// ── Test definitions ──────────────────────────────────────────────

async function runTest(name: string, category: string, fn: (token: string) => Promise<{ pass: boolean; msg: string }>): Promise<TestResult> {
  const start = Date.now();
  try {
    // We need a token first; if this fails the test fails
    const token = await getAuthToken();
    if (!token) return { name, category, passed: false, message: "Could not get auth token", durationMs: Date.now() - start };
    const { pass, msg } = await fn(token);
    return { name, category, passed: pass, message: msg, durationMs: Date.now() - start };
  } catch (err: any) {
    return { name, category, passed: false, message: `Exception: ${err.message}`, durationMs: Date.now() - start };
  }
}

function authHeaders(token: string): Record<string, string> {
  return { Cookie: `agent2077_token=${token}` };
}

const tests: Array<{ name: string; category: string; fn: (token: string) => Promise<{ pass: boolean; msg: string }> }> = [
  // ── Server Health ──
  {
    name: "Server responds",
    category: "health",
    fn: async () => {
      const res = await fetch(`${BASE}/api/auth/check`);
      return { pass: res.status === 401 || res.status === 200, msg: `HTTP ${res.status}` };
    },
  },
  {
    name: "Auth login works",
    category: "health",
    fn: async () => {
      const res = await request("POST", "/api/auth/login", { username: "Agent2077", password: "Agent2077" });
      return { pass: res.status === 200, msg: `HTTP ${res.status}` };
    },
  },
  {
    name: "Auth check with token",
    category: "health",
    fn: async (token) => {
      const res = await fetch(`${BASE}/api/auth/check`, { headers: authHeaders(token) });
      return { pass: res.status === 200, msg: `HTTP ${res.status}` };
    },
  },
  {
    name: "Endpoints list",
    category: "health",
    fn: async (token) => {
      const res = await fetch(`${BASE}/api/endpoints`, { headers: authHeaders(token) });
      return { pass: res.status === 200, msg: `HTTP ${res.status}` };
    },
  },
  {
    name: "Models list",
    category: "health",
    fn: async (token) => {
      const res = await fetch(`${BASE}/api/models`, { headers: authHeaders(token) });
      return { pass: res.status === 200, msg: `HTTP ${res.status}` };
    },
  },

  // ── Chat System ──
  {
    name: "Create conversation",
    category: "chat",
    fn: async (token) => {
      const res = await fetch(`${BASE}/api/conversations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(token) },
        body: JSON.stringify({ title: "Test conversation" }),
      });
      return { pass: res.status === 200 || res.status === 201, msg: `HTTP ${res.status}` };
    },
  },
  {
    name: "List conversations",
    category: "chat",
    fn: async (token) => {
      const res = await fetch(`${BASE}/api/conversations`, { headers: authHeaders(token) });
      const data = await res.json();
      return { pass: Array.isArray(data), msg: `Got ${data.length} conversations` };
    },
  },
  {
    name: "Get messages",
    category: "chat",
    fn: async (token) => {
      // Create a conversation first
      const convRes = await fetch(`${BASE}/api/conversations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(token) },
        body: JSON.stringify({ title: "Msg test" }),
      });
      const conv = await convRes.json();
      const res = await fetch(`${BASE}/api/conversations/${conv.id}/messages`, { headers: authHeaders(token) });
      return { pass: res.status === 200, msg: `HTTP ${res.status}` };
    },
  },

  // ── Projects ──
  {
    name: "Create project",
    category: "projects",
    fn: async (token) => {
      const res = await fetch(`${BASE}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(token) },
        body: JSON.stringify({ name: "test-project", description: "Automated test" }),
      });
      return { pass: res.status === 200 || res.status === 201, msg: `HTTP ${res.status}` };
    },
  },
  {
    name: "List projects",
    category: "projects",
    fn: async (token) => {
      const res = await fetch(`${BASE}/api/projects`, { headers: authHeaders(token) });
      const data = await res.json();
      return { pass: Array.isArray(data) && data.length > 0, msg: `Got ${data.length} projects` };
    },
  },
  {
    name: "Write project file",
    category: "projects",
    fn: async (token) => {
      const projRes = await fetch(`${BASE}/api/projects`, { headers: authHeaders(token) });
      const projects = await projRes.json();
      const proj = projects[0];
      if (!proj) return { pass: false, msg: "No project to test with" };
      const res = await fetch(`${BASE}/api/projects/${proj.id}/file`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders(token) },
        body: JSON.stringify({ path: "test.txt", content: "hello world" }),
      });
      return { pass: res.status === 200, msg: `HTTP ${res.status}` };
    },
  },
  {
    name: "Read project file",
    category: "projects",
    fn: async (token) => {
      const projRes = await fetch(`${BASE}/api/projects`, { headers: authHeaders(token) });
      const projects = await projRes.json();
      const proj = projects[0];
      if (!proj) return { pass: false, msg: "No project" };
      const res = await fetch(`${BASE}/api/projects/${proj.id}/file?path=test.txt`, { headers: authHeaders(token) });
      const data = await res.json();
      return { pass: data.content === "hello world", msg: `Content: ${data.content?.slice(0, 50)}` };
    },
  },
  {
    name: "File tree",
    category: "projects",
    fn: async (token) => {
      const projRes = await fetch(`${BASE}/api/projects`, { headers: authHeaders(token) });
      const projects = await projRes.json();
      const proj = projects[0];
      if (!proj) return { pass: false, msg: "No project" };
      const res = await fetch(`${BASE}/api/projects/${proj.id}/files`, { headers: authHeaders(token) });
      const data = await res.json();
      return { pass: Array.isArray(data), msg: `${data.length} entries` };
    },
  },
  {
    name: "Delete project file",
    category: "projects",
    fn: async (token) => {
      const projRes = await fetch(`${BASE}/api/projects`, { headers: authHeaders(token) });
      const projects = await projRes.json();
      const proj = projects[0];
      if (!proj) return { pass: false, msg: "No project" };
      const res = await fetch(`${BASE}/api/projects/${proj.id}/file?path=test.txt`, {
        method: "DELETE",
        headers: authHeaders(token),
      });
      return { pass: res.status === 200, msg: `HTTP ${res.status}` };
    },
  },

  // ── Skills ──
  {
    name: "List skills",
    category: "skills",
    fn: async (token) => {
      const res = await fetch(`${BASE}/api/skills`, { headers: authHeaders(token) });
      return { pass: res.status === 200, msg: `HTTP ${res.status}` };
    },
  },

  // ── Apps ──
  {
    name: "List apps",
    category: "apps",
    fn: async (token) => {
      const res = await fetch(`${BASE}/api/apps`, { headers: authHeaders(token) });
      return { pass: res.status === 200, msg: `HTTP ${res.status}` };
    },
  },

  // ── Memory ──
  {
    name: "List memory",
    category: "memory",
    fn: async (token) => {
      const res = await fetch(`${BASE}/api/memory`, { headers: authHeaders(token) });
      return { pass: res.status === 200, msg: `HTTP ${res.status}` };
    },
  },

  // ── Settings ──
  {
    name: "Get settings",
    category: "settings",
    fn: async (token) => {
      const res = await fetch(`${BASE}/api/endpoints`, { headers: authHeaders(token) });
      return { pass: res.status === 200, msg: `HTTP ${res.status}` };
    },
  },

  // ── Analytics ──
  {
    name: "Analytics overview",
    category: "analytics",
    fn: async (token) => {
      const res = await fetch(`${BASE}/api/analytics/overview`, { headers: authHeaders(token) });
      return { pass: res.status === 200, msg: `HTTP ${res.status}` };
    },
  },

  // ── MCP ──
  {
    name: "List MCP servers",
    category: "mcp",
    fn: async (token) => {
      const res = await fetch(`${BASE}/api/mcp-servers`, { headers: authHeaders(token) });
      return { pass: res.status === 200, msg: `HTTP ${res.status}` };
    },
  },

  // ── Background Tasks ──
  {
    name: "List background tasks",
    category: "tasks",
    fn: async (token) => {
      const res = await fetch(`${BASE}/api/background-tasks`, { headers: authHeaders(token) });
      return { pass: res.status === 200, msg: `HTTP ${res.status}` };
    },
  },

  // ── Benchmarks ──
  {
    name: "List benchmarks",
    category: "benchmarks",
    fn: async (token) => {
      const res = await fetch(`${BASE}/api/benchmarks`, { headers: authHeaders(token) });
      return { pass: res.status === 200, msg: `HTTP ${res.status}` };
    },
  },

  // ── Frontend Build ──
  {
    name: "Index.html served",
    category: "frontend",
    fn: async () => {
      const res = await fetch(`${BASE}/`);
      const text = await res.text();
      return { pass: text.includes("<!DOCTYPE html") || text.includes("<html"), msg: `${text.length} bytes` };
    },
  },
  {
    name: "JS bundle served",
    category: "frontend",
    fn: async () => {
      const res = await fetch(`${BASE}/`);
      const html = await res.text();
      const jsMatch = html.match(/src="([^"]+\.js)"/);
      if (!jsMatch) return { pass: false, msg: "No JS bundle in HTML" };
      const jsRes = await fetch(`${BASE}${jsMatch[1]}`);
      return { pass: jsRes.status === 200, msg: `${jsMatch[1]} — HTTP ${jsRes.status}` };
    },
  },
  {
    name: "CSS bundle served",
    category: "frontend",
    fn: async () => {
      const res = await fetch(`${BASE}/`);
      const html = await res.text();
      const cssMatch = html.match(/href="([^"]+\.css)"/);
      if (!cssMatch) return { pass: false, msg: "No CSS bundle in HTML" };
      const cssRes = await fetch(`${BASE}${cssMatch[1]}`);
      return { pass: cssRes.status === 200, msg: `${cssMatch[1]} — HTTP ${cssRes.status}` };
    },
  },
];

// ── Runner ──

export async function runAllTests(): Promise<{ passed: number; failed: number; total: number; results: TestResult[] }> {
  const results: TestResult[] = [];

  for (const test of tests) {
    const result = await runTest(test.name, test.category, test.fn);
    results.push(result);
    console.log(`[Test] ${result.passed ? "✓" : "✗"} ${result.category}/${result.name} (${result.durationMs}ms) — ${result.message}`);
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  return { passed, failed, total: results.length, results };
}

export function getTestSummary(results: TestResult[]): string {
  const categories = Array.from(new Set(results.map(r => r.category)));
  let summary = "";

  for (const cat of categories) {
    const catResults = results.filter(r => r.category === cat);
    const catPassed = catResults.filter(r => r.passed).length;
    summary += `\n### ${cat} (${catPassed}/${catResults.length})\n`;
    for (const r of catResults) {
      summary += `${r.passed ? "✅" : "❌"} ${r.name} — ${r.message} (${r.durationMs}ms)\n`;
    }
  }

  return summary;
}
