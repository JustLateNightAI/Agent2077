/**
 * ComfyUI Client — HTTP + WebSocket client for ComfyUI's native API.
 * Handles connection management, workflow queueing, progress tracking,
 * image upload/download, and node introspection.
 *
 * ComfyUI API reference:
 *   POST /prompt          — Queue a workflow for execution
 *   GET  /history/:id     — Fetch results for a completed prompt
 *   GET  /view            — Download a generated image
 *   POST /upload/image    — Upload an input image
 *   GET  /object_info     — List all available nodes + their schemas
 *   GET  /queue           — View running/pending queue
 *   POST /interrupt       — Interrupt current generation
 *   GET  /system_stats    — System info (VRAM, RAM, etc.)
 */
import { settingsStore } from "../storage.js";
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import http from "http";
import https from "https";

// ── Types ──────────────────────────────────────────────────────────

export interface ComfyUIConfig {
  host: string;
  port: number;
}

export interface QueueResult {
  prompt_id: string;
  number: number;
  node_errors: Record<string, any>;
}

export interface HistoryEntry {
  prompt: any;
  outputs: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }>;
  status: { status_str: string; completed: boolean };
}

export interface ProgressEvent {
  type: "progress" | "executing" | "execution_cached" | "executed" | "execution_error" | "execution_start";
  data: any;
}

export interface NodeInfo {
  input: { required: Record<string, any>; optional?: Record<string, any> };
  output: string[];
  output_is_list: boolean[];
  output_name: string[];
  name: string;
  display_name: string;
  description: string;
  category: string;
}

export interface ComfyUIStatus {
  connected: boolean;
  host: string;
  port: number;
  queueRunning: number;
  queuePending: number;
  systemStats?: any;
}

export interface GenerationResult {
  success: boolean;
  promptId: string;
  images: Array<{ filename: string; subfolder: string; type: string; data?: Buffer }>;
  error?: string;
  durationMs: number;
}

// ── Default images directory ───────────────────────────────────────

const IMAGES_DIR = path.join(process.env.HOME || "/root", "agent2077-images");
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

export { IMAGES_DIR };

// ── Client ─────────────────────────────────────────────────────────

let _objectInfoCache: Record<string, NodeInfo> | null = null;
let _objectInfoCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getConfig(): ComfyUIConfig {
  const host = settingsStore.get("comfyuiHost") || "127.0.0.1";
  const port = parseInt(settingsStore.get("comfyuiPort") || "8188");
  return { host, port };
}

function baseUrl(): string {
  const { host, port } = getConfig();
  return `http://${host}:${port}`;
}

/**
 * Generic HTTP request to ComfyUI.
 */
function request(
  method: string,
  urlPath: string,
  body?: any,
  options?: { timeout?: number }
): Promise<{ status: number; data: any; raw?: Buffer }> {
  return new Promise((resolve, reject) => {
    const { host, port } = getConfig();
    const url = new URL(urlPath, `http://${host}:${port}`);
    const isPost = method === "POST" || method === "PUT";
    const bodyStr = body && typeof body !== "string" ? JSON.stringify(body) : body;

    const reqOptions: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      timeout: options?.timeout || 30000,
      headers: isPost && bodyStr
        ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) }
        : {},
    };

    const req = http.request(reqOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        const contentType = res.headers["content-type"] || "";
        let data: any;
        if (contentType.includes("application/json")) {
          try { data = JSON.parse(raw.toString()); } catch { data = raw.toString(); }
        } else if (contentType.includes("image/")) {
          data = raw; // Return raw buffer for images
        } else {
          data = raw.toString();
        }
        resolve({ status: res.statusCode || 200, data, raw });
      });
    });

    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
    if (isPost && bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * Upload a file via multipart/form-data to ComfyUI.
 */
function uploadFile(
  filePath: string,
  filename: string,
  type: "image" | "mask" = "image",
  overwrite = false
): Promise<any> {
  return new Promise((resolve, reject) => {
    const { host, port } = getConfig();
    const boundary = "----ComfyUIBoundary" + Date.now();
    const fileData = fs.readFileSync(filePath);
    const ext = path.extname(filename).toLowerCase();
    const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";

    const header = [
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="image"; filename="${filename}"\r\n`,
      `Content-Type: ${mimeType}\r\n\r\n`,
    ].join("");

    const fields = [
      `\r\n--${boundary}\r\n`,
      `Content-Disposition: form-data; name="type"\r\n\r\ninput`,
      `\r\n--${boundary}\r\n`,
      `Content-Disposition: form-data; name="overwrite"\r\n\r\n${overwrite}`,
      `\r\n--${boundary}--\r\n`,
    ].join("");

    const headerBuf = Buffer.from(header, "utf-8");
    const fieldsBuf = Buffer.from(fields, "utf-8");
    const bodyLength = headerBuf.length + fileData.length + fieldsBuf.length;

    const reqOptions: http.RequestOptions = {
      hostname: host,
      port,
      path: `/upload/${type}`,
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": bodyLength,
      },
    };

    const req = http.request(reqOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { resolve(Buffer.concat(chunks).toString()); }
      });
    });

    req.on("error", reject);
    req.write(headerBuf);
    req.write(fileData);
    req.write(fieldsBuf);
    req.end();
  });
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Check if ComfyUI is reachable.
 */
export async function checkConnection(): Promise<ComfyUIStatus> {
  const { host, port } = getConfig();
  try {
    const { data } = await request("GET", "/queue", undefined, { timeout: 5000 });
    const queueRunning = data?.queue_running?.length || 0;
    const queuePending = data?.queue_pending?.length || 0;

    let systemStats: any;
    try {
      const statsRes = await request("GET", "/system_stats", undefined, { timeout: 5000 });
      systemStats = statsRes.data;
    } catch {}

    return { connected: true, host, port, queueRunning, queuePending, systemStats };
  } catch {
    return { connected: false, host, port, queueRunning: 0, queuePending: 0 };
  }
}

/**
 * Get all available nodes and their schemas. Cached for 5 min.
 */
export async function getObjectInfo(forceRefresh = false): Promise<Record<string, NodeInfo>> {
  if (!forceRefresh && _objectInfoCache && Date.now() - _objectInfoCacheTime < CACHE_TTL) {
    return _objectInfoCache;
  }
  const { data } = await request("GET", "/object_info", undefined, { timeout: 60000 });
  _objectInfoCache = data as Record<string, NodeInfo>;
  _objectInfoCacheTime = Date.now();
  return _objectInfoCache;
}

/**
 * List installed models of a given type (checkpoints, loras, vae, controlnet, upscale_models).
 */
export async function listModels(): Promise<{
  checkpoints: string[];
  loras: string[];
  vae: string[];
  controlnet: string[];
  upscale_models: string[];
}> {
  const info = await getObjectInfo();
  const result = { checkpoints: [] as string[], loras: [] as string[], vae: [] as string[], controlnet: [] as string[], upscale_models: [] as string[] };

  // CheckpointLoaderSimple → ckpt_name
  const ckptLoader = info["CheckpointLoaderSimple"];
  if (ckptLoader?.input?.required?.ckpt_name) {
    const vals = ckptLoader.input.required.ckpt_name;
    if (Array.isArray(vals) && Array.isArray(vals[0])) result.checkpoints = vals[0];
  }

  // LoraLoader → lora_name
  const loraLoader = info["LoraLoader"];
  if (loraLoader?.input?.required?.lora_name) {
    const vals = loraLoader.input.required.lora_name;
    if (Array.isArray(vals) && Array.isArray(vals[0])) result.loras = vals[0];
  }

  // VAELoader → vae_name
  const vaeLoader = info["VAELoader"];
  if (vaeLoader?.input?.required?.vae_name) {
    const vals = vaeLoader.input.required.vae_name;
    if (Array.isArray(vals) && Array.isArray(vals[0])) result.vae = vals[0];
  }

  // ControlNetLoader → control_net_name
  const cnLoader = info["ControlNetLoader"];
  if (cnLoader?.input?.required?.control_net_name) {
    const vals = cnLoader.input.required.control_net_name;
    if (Array.isArray(vals) && Array.isArray(vals[0])) result.controlnet = vals[0];
  }

  // UpscaleModelLoader → model_name
  const upLoader = info["UpscaleModelLoader"];
  if (upLoader?.input?.required?.model_name) {
    const vals = upLoader.input.required.model_name;
    if (Array.isArray(vals) && Array.isArray(vals[0])) result.upscale_models = vals[0];
  }

  return result;
}

/**
 * Queue a workflow for execution. Returns prompt_id.
 */
export async function queuePrompt(workflowApiJson: Record<string, any>, clientId?: string): Promise<QueueResult> {
  const body: any = { prompt: workflowApiJson };
  if (clientId) body.client_id = clientId;

  const { data, status } = await request("POST", "/prompt", body);

  if (status !== 200 || data.error) {
    throw new Error(`ComfyUI rejected workflow: ${JSON.stringify(data.error || data.node_errors || data)}`);
  }

  return data as QueueResult;
}

/**
 * Get execution history for a prompt_id.
 */
export async function getHistory(promptId: string): Promise<HistoryEntry | null> {
  const { data } = await request("GET", `/history/${promptId}`);
  return data[promptId] || null;
}

/**
 * Download a generated image from ComfyUI.
 */
export async function downloadImage(
  filename: string,
  subfolder: string,
  type: string = "output"
): Promise<Buffer> {
  const params = new URLSearchParams({ filename, subfolder, type });
  const { raw } = await request("GET", `/view?${params.toString()}`);
  return raw!;
}

/**
 * Upload an image to ComfyUI's input folder.
 */
export async function uploadImage(
  filePath: string,
  filename?: string,
  overwrite = true
): Promise<{ name: string; subfolder: string; type: string }> {
  const fname = filename || path.basename(filePath);
  return uploadFile(filePath, fname, "image", overwrite);
}

/**
 * Upload a mask to ComfyUI.
 */
export async function uploadMask(filePath: string, filename?: string): Promise<any> {
  const fname = filename || path.basename(filePath);
  return uploadFile(filePath, fname, "mask", true);
}

/**
 * Interrupt the current generation.
 */
export async function interrupt(): Promise<void> {
  await request("POST", "/interrupt");
}

/**
 * Get current queue status.
 */
export async function getQueue(): Promise<{ running: any[]; pending: any[] }> {
  const { data } = await request("GET", "/queue");
  return { running: data.queue_running || [], pending: data.queue_pending || [] };
}

/**
 * Queue a workflow and wait for completion with progress tracking.
 * Returns the generated images.
 */
export async function generateAndWait(
  workflowApiJson: Record<string, any>,
  onProgress?: (event: ProgressEvent) => void,
  timeoutMs = 600000 // 10 min default
): Promise<GenerationResult> {
  const startTime = Date.now();
  const clientId = `agent2077-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Queue the prompt
  const queueResult = await queuePrompt(workflowApiJson, clientId);
  const promptId = queueResult.prompt_id;

  if (queueResult.node_errors && Object.keys(queueResult.node_errors).length > 0) {
    return {
      success: false,
      promptId,
      images: [],
      error: `Node errors: ${JSON.stringify(queueResult.node_errors)}`,
      durationMs: Date.now() - startTime,
    };
  }

  // Try WebSocket for real-time tracking, fallback to polling
  const completed = await trackViaPolling(promptId, onProgress, timeoutMs);

  if (!completed) {
    return {
      success: false,
      promptId,
      images: [],
      error: "Generation timed out",
      durationMs: Date.now() - startTime,
    };
  }

  // Fetch results
  const history = await getHistory(promptId);
  if (!history) {
    return { success: false, promptId, images: [], error: "No history found", durationMs: Date.now() - startTime };
  }

  // Collect output images
  const images: GenerationResult["images"] = [];
  for (const nodeId of Object.keys(history.outputs)) {
    const nodeOutput = history.outputs[nodeId];
    if (nodeOutput.images) {
      for (const img of nodeOutput.images) {
        images.push(img);
      }
    }
  }

  return {
    success: true,
    promptId,
    images,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Generate and save images to local disk. Returns file paths.
 */
export async function generateAndSave(
  workflowApiJson: Record<string, any>,
  saveDir?: string,
  onProgress?: (event: ProgressEvent) => void
): Promise<{
  success: boolean;
  filePaths: string[];
  promptId: string;
  error?: string;
  durationMs: number;
}> {
  const dir = saveDir || IMAGES_DIR;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const result = await generateAndWait(workflowApiJson, onProgress);

  if (!result.success) {
    return { success: false, filePaths: [], promptId: result.promptId, error: result.error, durationMs: result.durationMs };
  }

  const filePaths: string[] = [];
  for (const img of result.images) {
    try {
      const imageData = await downloadImage(img.filename, img.subfolder, img.type);
      const ext = path.extname(img.filename) || ".png";
      const localName = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`;
      const localPath = path.join(dir, localName);
      fs.writeFileSync(localPath, imageData);
      filePaths.push(localPath);
    } catch (err: any) {
      console.warn(`[ComfyUI] Failed to download image ${img.filename}:`, err.message);
    }
  }

  return { success: true, filePaths, promptId: result.promptId, durationMs: result.durationMs };
}

// ── Polling fallback (more reliable than WS in many setups) ────────

async function trackViaPolling(
  promptId: string,
  onProgress?: (event: ProgressEvent) => void,
  timeoutMs = 600000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";

  while (Date.now() < deadline) {
    await sleep(1000);

    try {
      const history = await getHistory(promptId);
      if (history && history.status?.completed) {
        onProgress?.({ type: "executed", data: { prompt_id: promptId } });
        return true;
      }

      // Check if still in queue
      const queue = await getQueue();
      const inRunning = queue.running.some((item: any) => item[1] === promptId);
      const inPending = queue.pending.some((item: any) => item[1] === promptId);

      if (inRunning && lastStatus !== "running") {
        lastStatus = "running";
        onProgress?.({ type: "execution_start", data: { prompt_id: promptId } });
      } else if (inPending && lastStatus !== "pending") {
        lastStatus = "pending";
      } else if (!inRunning && !inPending && lastStatus === "running") {
        // Was running, now gone — check history one more time
        await sleep(500);
        const finalHistory = await getHistory(promptId);
        if (finalHistory) return true;
      }
    } catch {
      // ComfyUI might be busy, keep polling
    }
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Validate a workflow API JSON against available nodes.
 * Returns errors if any connections or values are invalid.
 */
export async function validateWorkflow(
  workflowApiJson: Record<string, any>
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  try {
    const objectInfo = await getObjectInfo();

    for (const [nodeId, node] of Object.entries(workflowApiJson)) {
      const nodeData = node as any;
      const nodeType = nodeData.class_type;

      if (!nodeType) {
        errors.push(`Node ${nodeId}: missing class_type`);
        continue;
      }

      const info = objectInfo[nodeType];
      if (!info) {
        errors.push(`Node ${nodeId}: unknown node type "${nodeType}"`);
        continue;
      }

      // Check required inputs
      if (info.input?.required) {
        for (const [inputName, inputSpec] of Object.entries(info.input.required)) {
          if (!(inputName in (nodeData.inputs || {}))) {
            errors.push(`Node ${nodeId} (${nodeType}): missing required input "${inputName}"`);
          }
        }
      }

      // Check that linked inputs reference valid nodes
      if (nodeData.inputs) {
        for (const [inputName, inputValue] of Object.entries(nodeData.inputs)) {
          if (Array.isArray(inputValue) && inputValue.length === 2) {
            const [sourceNodeId, sourceSlot] = inputValue;
            if (!workflowApiJson[String(sourceNodeId)]) {
              errors.push(`Node ${nodeId} (${nodeType}): input "${inputName}" references non-existent node ${sourceNodeId}`);
            }
          }
        }
      }
    }
  } catch (err: any) {
    errors.push(`Validation error: ${err.message}. ComfyUI might not be running.`);
  }

  return { valid: errors.length === 0, errors };
}
