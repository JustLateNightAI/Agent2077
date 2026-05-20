/**
 * Self-Dev Visual QA — captures screenshots and performs HTTP checks
 * against the dev server UI. Uses Playwright when available, falls back
 * to HTTP-based checks otherwise.
 */
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { SCREENSHOTS_DIR } from "./dev-workspace.js";

export { SCREENSHOTS_DIR };

// ── Ensure screenshots directory exists ───────────────────────────────────────

function ensureScreenshotsDir(): void {
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }
}

// ── Playwright-based screenshots ──────────────────────────────────────────────

/**
 * Capture a screenshot of a URL using Playwright.
 * Saves a timestamped PNG to SCREENSHOTS_DIR.
 * Returns the file path on success, throws if Playwright is unavailable.
 */
export async function captureScreenshot(
  url: string,
  options?: { width?: number; height?: number; selector?: string }
): Promise<string> {
  ensureScreenshotsDir();

  // Dynamic import — Playwright may not be installed
  let pw: typeof import("playwright-core");
  try {
    pw = await import("playwright-core");
  } catch {
    throw new Error("playwright-core is not installed");
  }

  const width = options?.width ?? 1280;
  const height = options?.height ?? 800;

  const browser = await pw.chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();

    await page.goto(url, { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(800); // Allow React/hydration to settle

    const timestamp = Date.now();
    const safeName = url
      .replace(/^https?:\/\//, "")
      .replace(/[^a-zA-Z0-9]/g, "_")
      .slice(0, 60);
    const filename = `${safeName}_${timestamp}.png`;
    const filePath = path.join(SCREENSHOTS_DIR, filename);

    if (options?.selector) {
      const element = await page.$(options.selector);
      if (element) {
        await element.screenshot({ path: filePath });
      } else {
        // Selector not found — fall back to full page
        await page.screenshot({ path: filePath, fullPage: true });
      }
    } else {
      await page.screenshot({ path: filePath, fullPage: true });
    }

    await page.close();
    return filePath;
  } finally {
    await browser.close();
  }
}

/**
 * Capture screenshots of multiple pages under a base URL.
 * Returns an array of { path, url } for successful captures
 * and { error, url } for failures.
 */
export async function captureMultiplePages(
  baseUrl: string,
  paths: string[]
): Promise<Array<{ url: string; filePath?: string; error?: string }>> {
  // Dynamic import — fail fast if unavailable
  try {
    await import("playwright-core");
  } catch {
    return paths.map((p) => ({
      url: `${baseUrl}${p}`,
      error: "playwright-core is not installed",
    }));
  }

  ensureScreenshotsDir();

  const results: Array<{ url: string; filePath?: string; error?: string }> = [];

  for (const pagePath of paths) {
    const url = `${baseUrl}${pagePath}`;
    try {
      const filePath = await captureScreenshot(url);
      results.push({ url, filePath });
    } catch (err: any) {
      results.push({ url, error: err.message });
    }
  }

  return results;
}

// ── HTTP-based fallback ───────────────────────────────────────────────────────

export interface HttpCheckResult {
  url: string;
  status: number;
  responseTimeMs: number;
  contentLength: number;
  contentType: string;
  error?: string;
}

/**
 * Perform an HTTP GET and return status, timing, and content metadata.
 */
export async function httpCheck(url: string): Promise<HttpCheckResult> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    const responseTimeMs = Date.now() - start;
    const body = await res.arrayBuffer();

    return {
      url,
      status: res.status,
      responseTimeMs,
      contentLength: body.byteLength,
      contentType: res.headers.get("content-type") ?? "",
    };
  } catch (err: any) {
    return {
      url,
      status: 0,
      responseTimeMs: Date.now() - start,
      contentLength: 0,
      contentType: "",
      error: err.message,
    };
  }
}

/**
 * Batch-check multiple endpoints under a base URL.
 */
export async function checkEndpoints(
  baseUrl: string,
  endpoints: string[]
): Promise<HttpCheckResult[]> {
  const results = await Promise.all(
    endpoints.map((ep) => httpCheck(`${baseUrl}${ep}`))
  );
  return results;
}

// ── Visual comparison ─────────────────────────────────────────────────────────

export interface CompareResult {
  different: boolean;
  diffPercent: number;
  diffImagePath?: string;
  error?: string;
}

/**
 * Compare two PNG screenshots using ImageMagick `compare`.
 * Returns { different, diffPercent, diffImagePath } if ImageMagick is available,
 * or { different: true, diffPercent: -1, error } if it is not.
 */
export function compareScreenshots(before: string, after: string): CompareResult {
  ensureScreenshotsDir();

  if (!fs.existsSync(before)) {
    return { different: false, diffPercent: 0, error: `Before image not found: ${before}` };
  }
  if (!fs.existsSync(after)) {
    return { different: false, diffPercent: 0, error: `After image not found: ${after}` };
  }

  // Check ImageMagick availability
  try {
    execSync("which compare", { stdio: "pipe" });
  } catch {
    return {
      different: true,
      diffPercent: -1,
      error: "ImageMagick `compare` not available",
    };
  }

  const timestamp = Date.now();
  const diffImagePath = path.join(SCREENSHOTS_DIR, `diff_${timestamp}.png`);

  try {
    // `compare -metric RMSE` exits with code 1 if images differ, 0 if identical.
    // We capture the metric output from stderr.
    execSync(
      `compare -metric RMSE "${before}" "${after}" "${diffImagePath}" 2>&1 || true`,
      { stdio: "pipe" }
    );

    // Re-run to capture the numeric metric
    let metricOutput = "";
    try {
      metricOutput = execSync(
        `compare -metric RMSE "${before}" "${after}" /dev/null 2>&1 || true`,
        { encoding: "utf-8", stdio: "pipe" }
      );
    } catch (e: any) {
      metricOutput = e.stdout ?? e.stderr ?? "";
    }

    // Output format: "1234 (0.0188)" — extract the parenthesised fraction
    const match = metricOutput.match(/\(([0-9.]+)\)/);
    const rawFraction = match ? parseFloat(match[1]) : 0;
    const diffPercent = parseFloat((rawFraction * 100).toFixed(2));
    const different = diffPercent > 0.1; // treat < 0.1% as identical (anti-aliasing noise)

    return {
      different,
      diffPercent,
      diffImagePath: fs.existsSync(diffImagePath) ? diffImagePath : undefined,
    };
  } catch (err: any) {
    return {
      different: true,
      diffPercent: -1,
      error: `compare failed: ${err.message}`,
    };
  }
}
