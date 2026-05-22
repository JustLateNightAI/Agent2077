/**
 * API Routes — Express route handlers for Agent2077
 */
import type { Express } from "express";
import type http from "http";
import { v4 as uuid } from "uuid";
import fs from "fs";
import os from "os";
import path from "path";
import {
  conversationStore, messageStore, endpointStore, modelStore,
  skillStore, appStore, benchmarkStore, analyticsStore,
  memoryStore, settingsStore, taskPlanStore, chatGroupStore, projectStore,
  mcpServerStore, backgroundTaskStore, generatedImageStore, workflowStore,
  getProjectsRoot,
} from "./storage.js";
import { connectMcpServer, disconnectMcpServer, getMcpServerTools } from "./lib/mcp-client.js";
import { enqueueTask, cancelTask, retryTask } from "./lib/background-tasks.js";
import { cancelChildRequests } from "./lib/sub-agent-executor.js";
import { createTerminalSession, listTerminalSessions } from "./lib/terminal-ws.js";
import { spawn, execSync } from "child_process";
import { requireAuth, handleLogin, handleChangePassword, handleChangeUsername, type AuthRequest } from "./middleware/auth.js";
import { routeMessage, ensureModelLoaded } from "./lib/orchestrator.js";
import { runAgentLoop, resolveConfirmation } from "./lib/agent-loop.js";
import { getRecentLogs, addLogClient, removeLogClient } from "./lib/log-buffer.js";
import { getRecentInspectorEntries, addInspectorClient, removeInspectorClient } from "./lib/inspector.js";
import { planTask, type TaskPlan } from "./lib/task-planner.js";
import { syncModels, pingEndpoint, cancelRequest, type ChatMessage } from "./lib/llm-client.js";
import { dockerManager } from "./docker/manager.js";
import { registerAppPort, unregisterAppPort } from "./lib/nginx-apps.js";
import { DB_PATH } from "./db.js";
import { chatCompletion } from "./lib/llm-client.js";
import { subscribe, broadcast, markActive, markInactive, isActive } from "./lib/conversation-bus.js";
import { getOrCreateStream, getStream, hasActiveStream, createStreamWriter } from "./lib/agent-stream.js";
import { subAgentExecutor, type SubtaskSpec } from "./lib/sub-agent-executor.js";
import multer from "multer";
import { pendingEdits } from "./tools/propose-edit.js";
import { pendingResetPermissions } from "./tools/self-dev-tools.js";
import {
  getDevInfo, readDevFile, listDevFiles, initDevSession, buildDev,
  startDevServer, stopDevServer, DEV_BASE, pushStatusEvent, clearStatusEvents, diffFile,
  promoteDevToProduction, listReleases, rollbackToRelease, deleteRelease,
} from "./lib/dev-workspace.js";
import { runAllTests, getTestSummary } from "./lib/self-dev-tests.js";
import { buildSelfDevPrompt, buildScreenshotAnalysisPrompt } from "./lib/self-dev-prompt.js";
import { SCREENSHOTS_DIR } from "./lib/self-dev-visual.js";
import {
  checkConnection as comfyCheckConnection, listModels as comfyListModels,
  generateAndSave, uploadImage as comfyUploadImage, IMAGES_DIR,
} from "./lib/comfyui-client.js";
import { WORKFLOW_TEMPLATES, buildTxt2Img } from "./lib/comfyui-workflows.js";

export function registerRoutes(server: http.Server, app: Express) {

  // ── Auth routes (no auth required) ────────────────────────────────
  app.post("/api/auth/login", handleLogin);

  app.get("/api/auth/check", requireAuth, (req: AuthRequest, res) => {
    res.json({ authenticated: true, username: req.username, userId: req.userId });
  });

  app.post("/api/auth/logout", (req, res) => {
    res.clearCookie("agent2077_token");
    res.json({ success: true });
  });

  // ── Health / Ping ───────────────────────────────────────────────────
  app.get("/api/ping", (_req, res) => {
    res.json({ pong: true, ts: new Date().toISOString() });
  });

  // All routes below require auth
  app.use("/api", requireAuth);

  // ── Auth management ───────────────────────────────────────────────
  app.post("/api/auth/change-password", handleChangePassword as any);
  app.post("/api/auth/change-username", handleChangeUsername as any);

  // ── Chat / Agent ──────────────────────────────────────────────────
  app.post("/api/chat", async (req: AuthRequest, res) => {
    const { conversationId, message, systemPrompt: bodySystemPrompt, images, attachments } = req.body;
    if (!message) return res.status(400).json({ error: "Message required" });
    if (typeof message === "string" && message.length > 50000) {
      return res.status(400).json({ error: "Message too long (max 50,000 characters)" });
    }

    // Use the body's systemPrompt if provided, otherwise fall back to the
    // conversation's stored systemPrompt (important for project-scoped chats
    // when the client doesn't send the prompt, e.g. API-only clients)
    let systemPrompt = bodySystemPrompt;
    if (!systemPrompt && conversationId) {
      const existingConv = conversationStore.getById(conversationId);
      if (existingConv?.systemPrompt) {
        systemPrompt = existingConv.systemPrompt;
      }
    }

    // SSE setup — stream directly to client for the initial response,
    // but the agent loop writes to an AgentStream so it survives disconnects.
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const requestId = uuid();
    // Send requestId to client so stop button can target the right request
    res.write(`data: ${JSON.stringify({ type: "request_id", requestId })}\n\n`);

    let convId = conversationId;
    let agentStream: ReturnType<typeof getOrCreateStream> | null = null;
    let out: ReturnType<typeof createStreamWriter> | null = null;
    try {
      if (!convId) {
        const conv = conversationStore.create({
          title: message.slice(0, 80),
          systemPrompt: systemPrompt || null,
        });
        convId = conv.id;
        res.write(`data: ${JSON.stringify({ type: "conversation", id: conv.id, title: conv.title })}\n\n`);
      }

      // Create an AgentStream that buffers all events.
      // The agent loop writes to the stream; the client subscribes to it.
      // If the browser tab closes, the stream (and the loop) keeps running.
      agentStream = getOrCreateStream(convId, requestId);
      const streamWriter = createStreamWriter(agentStream);
      out = streamWriter;

      // Subscribe this client (res) to the stream for live events.
      // Also broadcast to other tabs via conversation-bus.
      const unsubStream = agentStream.subscribe(res);
      // Note: res already has SSE headers set above, but subscribe() sets them
      // idempotently. The subscribe replays any buffered events (none yet).

      // Wrap the stream's write to also broadcast to conversation-bus subscribers
      const originalStreamWrite = agentStream.write.bind(agentStream);
      agentStream.write = function(sseData: string): boolean {
        const result = originalStreamWrite(sseData);
        // Broadcast to other tabs (excluding direct subscribers of this stream)
        broadcast(convId, sseData);
        return result;
      };

      markActive(convId);

      // If there are file attachments, append their content to the message for the LLM
      let augmentedMessage = message;
      if (attachments && attachments.length > 0) {
        const fileContents = attachments.map((a: any) =>
          `\n\n--- Attached File: ${a.name} ---\n${a.content}\n--- End of ${a.name} ---`
        ).join("\n");
        augmentedMessage = message + fileContents;
      }

      // Save user message (with optional images and attachments)
      const userMsg = messageStore.create({
        conversationId: convId,
        role: "user",
        content: message,
        images: images && images.length > 0 ? JSON.stringify(images) : null,
        attachments: attachments && attachments.length > 0 ? JSON.stringify(attachments) : null,
      });
      out.write(`data: ${JSON.stringify({ type: "user_message", id: userMsg.id })}\n\n`);

      // Route the message to the best model
      const autoRouting = settingsStore.get("autoRouting") !== "false";
      console.log(`[Chat] Message: "${message.slice(0, 80)}..." | autoRouting=${autoRouting} | convId=${convId}`);
      const routing = await routeMessage(message, autoRouting, convId);

      if (!routing) {
        console.warn(`[Chat] No routing found — no enabled models available`);
        out.write(`data: ${JSON.stringify({ type: "error", content: "No models available. Add and enable models in Settings." })}\n\n`);
        out.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
        agentStream.end();
        return;
      }

      console.log(`[Chat] Routed → task=${routing.taskType}, model=${routing.model.modelId}, endpoint=${routing.endpoint.name}, confidence=${routing.confidence.toFixed(2)}`);
      out.write(`data: ${JSON.stringify({
        type: "routing",
        taskType: routing.taskType,
        model: routing.model.modelId,
        endpoint: routing.endpoint.name,
        confidence: routing.confidence,
      })}\n\n`);

      // Ensure the selected model is loaded with preferred context length
      // This calls LM Studio's load API if needed — fast no-op if already loaded correctly
      try {
        if (routing.model.preferredContextLength && routing.model.preferredContextLength > 0) {
          const ctxLabel = routing.model.preferredContextLength >= 1000000
            ? `${(routing.model.preferredContextLength / 1000000).toFixed(1)}M`
            : routing.model.preferredContextLength >= 1000
              ? `${Math.round(routing.model.preferredContextLength / 1000)}k`
              : String(routing.model.preferredContextLength);
          out.write(`data: ${JSON.stringify({ type: "status", message: "Loading model...", detail: `${routing.model.modelId.split("/").pop()} (ctx=${ctxLabel}) — this may take several minutes for large context`, timestamp: Date.now() })}\n\n`);
        }
        await ensureModelLoaded(routing.model, routing.endpoint);
      } catch (err: any) {
        // ensureModelLoaded throws when load fails after explicit unload (no model available)
        // Don't continue — show the error and stop.
        console.error(`[Chat] Model load failed critically:`, err.message);
        out.write(`data: ${JSON.stringify({ type: "error", content: `Model failed to load: ${err.message}` })}\n\n`);
        out.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
        agentStream.end();
        return;
      }

      // Task planning — generate a step-by-step plan for complex tasks
      const orchestratorEp = endpointStore.getOrchestrator();
      const orchestratorModel = orchestratorEp
        ? modelStore.getByEndpoint(orchestratorEp.id).find(m => m.isEnabled)
        : undefined;

      let plan: TaskPlan | undefined;
      try {
        out.write(`data: ${JSON.stringify({ type: "status", message: "Planning...", timestamp: Date.now() })}\n\n`);
        plan = await planTask(message, orchestratorEp || undefined, orchestratorModel, convId);
        console.log(`[Chat] Plan: needsPlan=${plan.needsPlan}, steps=${plan.steps.length}, reason=${plan.reasoning}`);
      } catch (err: any) {
        console.warn(`[Chat] Planning failed, continuing without plan:`, err.message);
      }

      // ── Clarification mode ───────────────────────────────────────────
      // If the planner determined the request is vague, send the clarification
      // question as an assistant message and stop — don't enter the agent loop.
      if (plan?.needsClarification && plan.clarificationQuestion) {
        console.log(`[Chat] Clarification needed — sending question to user`);
        const clarifyContent = plan.clarificationQuestion;

        // Save clarification as an assistant message in DB
        const assistantMsg = messageStore.create({
          conversationId: convId,
          role: "assistant",
          content: clarifyContent,
        });

        // Stream the clarification question to the client as content events
        // (the same format the agent loop uses, so the UI renders it naturally)
        out.write(`data: ${JSON.stringify({ type: "assistant_message", id: assistantMsg.id })}\n\n`);

        // Stream character-by-character would be wasteful; send it in small chunks
        const chunkSize = 12;
        for (let i = 0; i < clarifyContent.length; i += chunkSize) {
          const chunk = clarifyContent.slice(i, i + chunkSize);
          out.write(`data: ${JSON.stringify({ type: "content", content: chunk })}\n\n`);
        }

        out.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
        try { agentStream.end(); } catch { /* already ended */ }
        if (convId) markInactive(convId);
        return;
      }

      // Check if plan has parallel tasks — dispatch via sub-agent executor
      if (plan?.needsPlan && plan.parallelGroups && plan.parallelGroups.length > 0) {
        const parallelTasks: SubtaskSpec[] = plan.parallelGroups.flat().map(stepIdx => {
          const step = plan!.steps[stepIdx];
          return {
            title: step?.title || `Step ${stepIdx + 1}`,
            description: step?.description || "",
            taskType: routing.taskType,
          };
        });

        if (parallelTasks.length > 0) {
          out.write(`data: ${JSON.stringify({ type: "status", message: "Spawning sub-agents...", detail: `${parallelTasks.length} parallel tasks`, timestamp: Date.now() })}\n\n`);

          // Create a task plan record in DB
          const dbPlan = taskPlanStore.create({
            conversationId: convId,
            originalRequest: message,
            planJson: JSON.stringify(plan),
            status: "running",
          });

          try {
            const outcomes = await subAgentExecutor.executeSubtasks(
              dbPlan.id,
              parallelTasks,
              convId,
              out as any,
              requestId
            );

            // Inject sub-agent results into the conversation for the synthesis pass
            const subAgentSummary = outcomes.map(o =>
              `### Sub-task: ${parallelTasks[o.specIndex]?.title}\nResult: ${o.result}`
            ).join("\n\n");

            // Save sub-agent results as an assistant message (NOT user!) so:
            // 1. They display correctly with the bot avatar in the UI
            // 2. They don't create consecutive user messages that LM Studio rejects
            messageStore.create({
              conversationId: convId,
              role: "assistant",
              content: `[Sub-agent results]\n\n${subAgentSummary}`,
            });

            // Remove parallel steps from the plan, keep remaining (e.g., verification)
            const parallelIndexSet = new Set(plan.parallelGroups.flat());
            plan = {
              ...plan,
              steps: plan.steps.filter((_, i) => !parallelIndexSet.has(i)),
              parallelGroups: undefined,
            };
          } catch (err: any) {
            console.warn(`[Chat] Sub-agent execution failed:`, err.message);
          }
        }
      }

      // Build conversation history for context
      // Safety cap: fetch at most 200 messages from DB — agent-loop.ts does model-aware
      // trimming and compression, but no reason to pull thousands of messages from SQLite
      const allHistory = messageStore.getByConversation(convId);
      const MAX_HISTORY_FROM_DB = 200;
      const history = allHistory.length > MAX_HISTORY_FROM_DB
        ? allHistory.slice(-MAX_HISTORY_FROM_DB)
        : allHistory;
      if (allHistory.length > MAX_HISTORY_FROM_DB) {
        console.log(`[Chat] Trimmed DB history: ${allHistory.length} → ${MAX_HISTORY_FROM_DB} messages`);
      }
      // Build chat messages from DB history.
      // IMPORTANT: Do NOT reconstruct tool_calls/tool_call_id on historical messages.
      // LM Studio's OpenAI-compatible API has strict structural requirements:
      // every assistant message with tool_calls MUST be followed by matching tool
      // role messages with the same tool_call_id. Our DB stores tool calls and
      // results in a single assistant row, so reconstructing them creates orphaned
      // tool_calls with no matching responses → 400 "Invalid messages in payload".
      // The assistant's text content already summarizes what was done, so stripping
      // the raw tool_call objects from history loses nothing meaningful.
      const filteredHistory = history.filter(m => m.role !== 'tool');
      const chatMessages: ChatMessage[] = filteredHistory
        .map((m, idx) => {
          // For the last user message, use augmentedMessage (includes file attachments)
          const isLastUserMsg = idx === filteredHistory.length - 1 && m.role === 'user' && m.id === userMsg.id;
          const messageContent = isLastUserMsg ? augmentedMessage : (m.content || '');

          // If user message has images, include them as multimodal content
          // (OpenAI-compatible vision format)
          if (m.role === 'user' && m.images) {
            try {
              const imgs = JSON.parse(m.images) as Array<{name: string, base64: string, mimeType: string}>;
              if (imgs.length > 0) {
                if (!routing.model.supportsVision) {
                  // Model doesn't support vision — send text only, log a warning
                  console.warn(`[Chat] Stripping ${imgs.length} image(s) from message — model ${routing.model.modelId} does not support vision`);
                  // Send a note in the text so the agent knows images were attached but stripped
                  const strippedNote = imgs.length === 1
                    ? `\n\n[Note: 1 image was attached but this model does not support vision — image skipped]`
                    : `\n\n[Note: ${imgs.length} images were attached but this model does not support vision — images skipped]`;
                  const isLastMsg = idx === filteredHistory.length - 1 && m.role === 'user' && m.id === userMsg.id;
                  return { role: m.role as any, content: messageContent + (isLastMsg ? strippedNote : '') };
                }
                const content: any[] = [{ type: 'text', text: messageContent }];
                for (const img of imgs) {
                  content.push({
                    type: 'image_url',
                    image_url: { url: img.base64 }, // base64 data URL
                  });
                }
                return { role: m.role as any, content };
              }
            } catch {}
          }
          return { role: m.role as any, content: messageContent };
        });

      // Everything goes through the agent loop — plan is injected into the system prompt
      // CRITICAL: pass `out` (StreamWriter) instead of `res` so the agent loop writes
      // to the AgentStream buffer. This means the loop survives browser disconnects.
      await runAgentLoop({
        conversationId: convId,
        messages: chatMessages,
        model: routing.model,
        endpoint: routing.endpoint,
        taskType: routing.taskType,
        res: out,
        requestId,
        systemPrompt,
        plan: plan?.needsPlan ? plan : undefined,
      });
    } catch (err: any) {
      console.error("[Chat] Error:", err);
      try {
        const w = out || res;
        w.write(`data: ${JSON.stringify({ type: "error", content: err.message })}\n\n`);
        w.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
      } catch { /* client disconnected */ }
    } finally {
      if (convId) markInactive(convId);
    }

    try { if (agentStream) agentStream.end(); } catch { /* already ended */ }
  });

  app.post("/api/chat/stop", (req, res) => {
    const { requestId } = req.body;
    if (requestId) {
      cancelRequest(requestId);
      // Also cancel any sub-agents that were spawned by this request
      cancelChildRequests(requestId);
    }
    res.json({ success: true });
  });

  // ── Confirmation gate for destructive tool calls ─────────────────
  app.post("/api/chat/confirm", (req, res) => {
    const { confirmId, approved } = req.body;
    if (!confirmId) return res.status(400).json({ error: "Missing confirmId" });
    resolveConfirmation(confirmId, !!approved);
    res.json({ success: true });
  });

  // ── Reconnectable stream subscription (replay + live) ───────────────
  // When the browser reconnects (e.g., tab was closed and reopened), this
  // replays all buffered events from the AgentStream and then streams live.
  // This is the key endpoint that makes agent loops survive browser disconnects.
  app.get("/api/conversations/:id/stream", (req, res) => {
    const convId = parseInt(req.params.id);
    if (isNaN(convId)) return res.status(400).json({ error: "Invalid conversation ID" });

    // Check if there's an active AgentStream for this conversation
    const stream = getStream(convId);
    if (stream) {
      // AgentStream exists — use its subscribe() which replays buffered events
      // then streams live. If the stream is done, it replays everything and closes.
      const unsub = stream.subscribe(res);
      req.on("close", unsub);
      return;
    }

    // No AgentStream — fall back to conversation-bus for live-only events
    // (e.g., other tabs broadcasting)
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    if (!isActive(convId)) {
      res.write(`data: ${JSON.stringify({ type: "stream_end" })}\n\n`);
      res.end();
      return;
    }

    const unsub = subscribe(convId, res);
    req.on("close", unsub);
    res.on("close", unsub);
  });

  // ── Check if conversation is active ─────────────────────────────────
  app.get("/api/conversations/:id/active", (req, res) => {
    const convId = parseInt(req.params.id);
    if (isNaN(convId)) return res.status(400).json({ error: "Invalid conversation ID" });
    res.json({ active: isActive(convId) });
  });

  // ── Stream status (polling fallback) ────────────────────────────────
  // Returns the status of an active agent stream — event count, done state,
  // subscriber count. Useful as a polling fallback when SSE isn't reliable.
  app.get("/api/conversations/:id/stream-status", (req, res) => {
    const convId = parseInt(req.params.id);
    if (isNaN(convId)) return res.status(400).json({ error: "Invalid conversation ID" });

    const stream = getStream(convId);
    if (!stream) {
      return res.json({
        active: false,
        done: true,
        eventCount: 0,
        subscriberCount: 0,
      });
    }

    res.json({
      active: !stream.done,
      ...stream.status(),
    });
  });

  // ── Conversations ─────────────────────────────────────────────────
  app.get("/api/conversations", (req, res) => {
    // Exclude the self-dev conversation — it has its own dedicated page
    // and should never appear in the regular chat sidebar
    const selfDevConvId = settingsStore.get("selfDevConversationId");
    const showWorkspaceChats = settingsStore.get("paths.showWorkspaceChatsInSidebar") === "true";

    const all = conversationStore.getAll();

    // Build set of conversation IDs that belong to workspace projects
    let workspaceConvIds: Set<string> = new Set();
    if (!showWorkspaceChats) {
      const projects = projectStore.getAll();
      for (const p of projects) {
        if (p.conversationId) workspaceConvIds.add(String(p.conversationId));
      }
    }

    const filtered = all.filter(c => {
      if (selfDevConvId && String(c.id) === String(selfDevConvId)) return false;
      if (workspaceConvIds.has(String(c.id))) return false;
      return true;
    });
    res.json(filtered);
  });

  app.get("/api/conversations/:id", (req, res) => {
    const conv = conversationStore.getById(parseInt(req.params.id));
    if (!conv) return res.status(404).json({ error: "Not found" });
    res.json(conv);
  });

  app.get("/api/conversations/:id/messages", (req, res) => {
    res.json(messageStore.getByConversation(parseInt(req.params.id)));
  });

  // Delete a single message
  app.delete("/api/messages/:id", requireAuth, (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid message id" });
    messageStore.delete(id);
    res.json({ ok: true });
  });

  // Resend: delete all messages after this user message, client re-runs the agent
  app.post("/api/messages/:id/resend", requireAuth, async (req, res) => {
    const msgId = parseInt(req.params.id);
    if (isNaN(msgId)) return res.status(400).json({ error: "Invalid message id" });

    // Find the target message across all conversations
    const allConvs = conversationStore.getAll();
    let targetMsg: any = null;
    for (const conv of allConvs) {
      const msgs = messageStore.getByConversation(conv.id);
      const found = msgs.find(m => m.id === msgId);
      if (found) { targetMsg = found; break; }
    }
    if (!targetMsg) return res.status(404).json({ error: "Message not found" });
    if (targetMsg.role !== "user") return res.status(400).json({ error: "Can only resend user messages" });

    // Delete everything after this message (assistant responses, tool messages, etc.)
    messageStore.deleteAfter(targetMsg.conversationId, msgId);

    res.json({ ok: true, conversationId: targetMsg.conversationId, content: targetMsg.content });
  });


  app.post("/api/conversations", (req, res) => {
    res.json(conversationStore.create(req.body));
  });

  app.patch("/api/conversations/:id", (req, res) => {
    const updated = conversationStore.update(parseInt(req.params.id), req.body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  });

  app.delete("/api/conversations/:id", (req, res) => {
    conversationStore.delete(parseInt(req.params.id));
    res.json({ success: true });
  });

  app.post("/api/conversations/:id/branch", (req, res) => {
    const sourceId = parseInt(req.params.id);
    const { messageId } = req.body;

    if (!messageId || isNaN(messageId)) {
      return res.status(400).json({ error: "messageId required" });
    }

    const sourceConv = conversationStore.getById(sourceId);
    if (!sourceConv) return res.status(404).json({ error: "Conversation not found" });

    // Get messages up to and including the target message
    const allMessages = messageStore.getByConversation(sourceId);
    const cutoffIndex = allMessages.findIndex(m => m.id === messageId);
    if (cutoffIndex === -1) return res.status(404).json({ error: "Message not found" });
    const messagesToCopy = allMessages.slice(0, cutoffIndex + 1);

    // Create branched conversation
    const branchedConv = conversationStore.create({
      title: `Branch of ${sourceConv.title}`,
      systemPrompt: sourceConv.systemPrompt || null,
    });

    // Copy messages into new conversation
    for (const msg of messagesToCopy) {
      messageStore.create({
        conversationId: branchedConv.id,
        role: msg.role,
        content: msg.content,
        modelId: msg.modelId || undefined,
        endpointId: msg.endpointId || undefined,
        toolCalls: msg.toolCalls || undefined,
        toolResults: msg.toolResults || undefined,
        tokenCount: msg.tokenCount || undefined,
        durationMs: msg.durationMs || undefined,
        taskType: msg.taskType || undefined,
      });
    }

    res.json(branchedConv);
  });

  // ── Endpoints ─────────────────────────────────────────────────────
  app.get("/api/endpoints", (req, res) => {
    res.json(endpointStore.getAll());
  });

  app.post("/api/endpoints", (req, res) => {
    res.json(endpointStore.create(req.body));
  });

  app.patch("/api/endpoints/:id", (req, res) => {
    const updated = endpointStore.update(parseInt(req.params.id), req.body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  });

  app.delete("/api/endpoints/:id", (req, res) => {
    modelStore.deleteByEndpoint(parseInt(req.params.id));
    endpointStore.delete(parseInt(req.params.id));
    res.json({ success: true });
  });

  app.post("/api/endpoints/:id/sync", async (req, res) => {
    const endpoint = endpointStore.getById(parseInt(req.params.id));
    if (!endpoint) return res.status(404).json({ error: "Not found" });

    const models = await syncModels(endpoint);
    // Upsert models — update context lengths for existing, create new ones
    const existing = modelStore.getByEndpoint(endpoint.id);
    const existingMap = new Map(existing.map(m => [m.modelId, m]));

    let added = 0;
    let updated = 0;
    for (const m of models) {
      const ex = existingMap.get(m.id);
      if (!ex) {
        modelStore.create({
          endpointId: endpoint.id,
          modelId: m.id,
          type: m.type,
          quantization: m.quantization || null,
          maxContextLength: m.maxContextLength || null,
          loadedContextLength: m.loadedContextLength || null,
          supportsVision: m.supportsVision ?? false,
        });
        added++;
      } else {
        // Always update context lengths on sync (model may have been reloaded with different context)
        const updates: Record<string, any> = {};
        if (m.maxContextLength && m.maxContextLength !== ex.maxContextLength) {
          updates.maxContextLength = m.maxContextLength;
        }
        if (m.loadedContextLength && m.loadedContextLength !== ex.loadedContextLength) {
          updates.loadedContextLength = m.loadedContextLength;
        }
        if (m.quantization && m.quantization !== ex.quantization) {
          updates.quantization = m.quantization;
        }
        if ((m.supportsVision ?? false) !== ex.supportsVision) {
          updates.supportsVision = m.supportsVision ?? false;
        }
        if (Object.keys(updates).length > 0) {
          modelStore.update(ex.id, updates);
          updated++;
        }
      }
    }

    endpointStore.update(endpoint.id, { lastSeen: new Date().toISOString() });
    res.json({ synced: models.length, added, updated });
  });

  app.post("/api/endpoints/:id/ping", async (req, res) => {
    const endpoint = endpointStore.getById(parseInt(req.params.id));
    if (!endpoint) return res.status(404).json({ error: "Not found" });
    const alive = await pingEndpoint(endpoint);
    if (alive) endpointStore.update(endpoint.id, { lastSeen: new Date().toISOString() });
    res.json({ alive });
  });

  // ── Models ────────────────────────────────────────────────────────
  app.get("/api/models", (req, res) => {
    res.json(modelStore.getAll());
  });

  app.patch("/api/models/:id", (req, res) => {
    const updated = modelStore.update(parseInt(req.params.id), req.body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  });

  // ── Skills ────────────────────────────────────────────────────────
  app.get("/api/skills", (req, res) => {
    res.json(skillStore.getAll());
  });

  app.get("/api/skills/pending", (req, res) => {
    res.json(skillStore.getPending());
  });

  app.get("/api/skills/:id", (req, res) => {
    const skill = skillStore.getById(parseInt(req.params.id));
    if (!skill) return res.status(404).json({ error: "Not found" });
    res.json(skill);
  });

  app.post("/api/skills", (req, res) => {
    res.json(skillStore.create(req.body));
  });

  app.patch("/api/skills/:id", (req, res) => {
    const id = parseInt(req.params.id);
    const skill = skillStore.getById(id);
    if (!skill) return res.status(404).json({ error: "Not found" });

    // Save version before updating
    if (req.body.instructions && req.body.instructions !== skill.instructions) {
      skillStore.saveVersion(id, skill.version, skill.instructions, skill.systemPrompt, req.body.changeReason || null);
      req.body.version = skill.version + 1;
    }

    res.json(skillStore.update(id, req.body));
  });

  app.post("/api/skills/:id/approve", (req, res) => {
    const updated = skillStore.update(parseInt(req.params.id), { approvalStatus: "approved" });
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  });

  app.post("/api/skills/:id/reject", (req, res) => {
    const updated = skillStore.update(parseInt(req.params.id), { approvalStatus: "rejected" });
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  });

  app.get("/api/skills/:id/versions", (req, res) => {
    res.json(skillStore.getVersions(parseInt(req.params.id)));
  });

  app.delete("/api/skills/:id", (req, res) => {
    skillStore.delete(parseInt(req.params.id));
    res.json({ success: true });
  });

  // ── App download (zip) ────────────────────────────────────────────
  app.get("/api/apps/:id/download", async (req, res) => {
    const appId = parseInt(req.params.id);
    const app2 = appStore.getById(appId);
    if (!app2) return res.status(404).json({ error: "App not found" });

    const buildDir = path.join(process.cwd(), "workspace", "apps", `app-${appId}`);
    if (!fs.existsSync(buildDir)) return res.status(404).json({ error: "App files not found" });

    try {
      const archiver = (await import("archiver")).default;
      const archive = archiver("zip", { zlib: { level: 9 } });

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${app2.name.replace(/[^a-z0-9]/gi, "-")}.zip"`);

      archive.pipe(res);
      archive.directory(buildDir, false);
      await archive.finalize();
    } catch (err: any) {
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    }
  });

  // ── Apps (App Store) ──────────────────────────────────────────────
  app.get("/api/apps", (req, res) => {
    res.json(appStore.getAll());
  });

  app.get("/api/apps/:id", (req, res) => {
    const app2 = appStore.getById(parseInt(req.params.id));
    if (!app2) return res.status(404).json({ error: "Not found" });
    res.json(app2);
  });

  app.post("/api/apps", (req, res) => {
    const port = appStore.getNextPort();
    res.json(appStore.create({ ...req.body, port }));
  });

  app.post("/api/apps/:id/deploy", async (req, res) => {
    const id = parseInt(req.params.id);
    const app2 = appStore.getById(id);
    if (!app2) return res.status(404).json({ error: "Not found" });

    try {
      const { dockerfile, buildContext } = req.body;
      const port = app2.port || appStore.getNextPort();
      const result = await dockerManager.deployApp(
        id,
        dockerfile || app2.dockerfile || "",
        buildContext || app2.buildPath || "",
        port,
        app2.internalPort,
      );
      // App is now running — register nginx proxy so it's reachable on LAN
      registerAppPort(port);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/apps/:id/start", async (req, res) => {
    try {
      const appId = parseInt(req.params.id);
      await dockerManager.startApp(appId);
      // Register nginx proxy so agent2077.local:<port> resolves on the LAN
      const startedApp = appStore.getById(appId);
      if (startedApp?.port) registerAppPort(startedApp.port);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/apps/:id/stop", async (req, res) => {
    try {
      const appId = parseInt(req.params.id);
      // Fetch port before stopping (it's cleared after stop in some paths)
      const stoppingApp = appStore.getById(appId);
      await dockerManager.stopApp(appId);
      // Remove nginx proxy for this port
      if (stoppingApp?.port) unregisterAppPort(stoppingApp.port);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/apps/:id/logs", async (req, res) => {
    const tail = parseInt(req.query.tail as string) || 100;
    const logs = await dockerManager.getAppLogs(parseInt(req.params.id), tail);
    res.json({ logs });
  });

  // ── App rollback + version listing ──────────────────────────────
  app.get("/api/apps/:id/versions", (req, res) => {
    const appId = parseInt(req.params.id);
    const app2 = appStore.getById(appId);
    if (!app2) return res.status(404).json({ error: "Not found" });

    const currentVersion = (app2 as any).version || 1;
    const versions: { version: number; isCurrent: boolean; hasBackup: boolean }[] = [];

    // List current version + all backups found on disk
    for (let v = currentVersion; v >= 1; v--) {
      if (v === currentVersion) {
        versions.push({ version: v, isCurrent: true, hasBackup: false });
      } else {
        const backupDir = path.join(process.cwd(), "workspace", "apps", `app-${appId}-v${v}`);
        if (fs.existsSync(backupDir)) {
          versions.push({ version: v, isCurrent: false, hasBackup: true });
        }
      }
    }

    res.json({ appId, currentVersion, versions });
  });

  app.post("/api/apps/:id/rollback", async (req, res) => {
    const appId = parseInt(req.params.id);
    const { targetVersion } = req.body;

    const app2 = appStore.getById(appId);
    if (!app2) return res.status(404).json({ error: "Not found" });

    const currentVersion = (app2 as any).version || 1;

    // Determine target version
    let rollbackTo = targetVersion ? parseInt(targetVersion) : null;
    const appsDir = path.join(process.cwd(), "workspace", "apps");

    if (!rollbackTo) {
      // Find most recent backup
      for (let v = currentVersion - 1; v >= 1; v--) {
        if (fs.existsSync(path.join(appsDir, `app-${appId}-v${v}`))) {
          rollbackTo = v;
          break;
        }
      }
    }

    if (!rollbackTo) {
      return res.status(400).json({ error: "No previous version backups found" });
    }

    const backupDir = path.join(appsDir, `app-${appId}-v${rollbackTo}`);
    if (!fs.existsSync(backupDir)) {
      return res.status(404).json({ error: `Backup for v${rollbackTo} not found` });
    }

    const buildDir = path.join(appsDir, `app-${appId}`);

    try {
      // Save current as backup
      const currentBackupDir = path.join(appsDir, `app-${appId}-v${currentVersion}`);
      if (fs.existsSync(buildDir) && !fs.existsSync(currentBackupDir)) {
        fs.cpSync(buildDir, currentBackupDir, { recursive: true });
      }

      // Restore from backup
      if (fs.existsSync(buildDir)) fs.rmSync(buildDir, { recursive: true, force: true });
      fs.cpSync(backupDir, buildDir, { recursive: true });

      // Update DB
      appStore.update(appId, {
        version: rollbackTo as any,
        status: "stopped",
        errorLog: null,
      });

      // Rebuild Docker container
      if (app2.dockerfile && dockerManager.isReady()) {
        try {
          await dockerManager.deployApp(appId, app2.dockerfile, buildDir, app2.port!, app2.internalPort);
          await dockerManager.stopApp(appId);
        } catch (err: any) {
          console.warn(`[Rollback API] Docker rebuild failed:`, err.message);
        }
      }

      res.json({ success: true, previousVersion: currentVersion, restoredVersion: rollbackTo });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/apps/:id", async (req, res) => {
    const appId = parseInt(req.params.id);
    // Capture port before removal so we can clean up the nginx config
    const deletingApp = appStore.getById(appId);
    try {
      await dockerManager.removeApp(appId);
      if (deletingApp?.port) unregisterAppPort(deletingApp.port);
      res.json({ success: true });
    } catch (err: any) {
      // If Docker container is already gone, still clean up the DB entry
      try { appStore.delete(appId); } catch { }
      if (deletingApp?.port) unregisterAppPort(deletingApp.port);
      res.json({ success: true });
    }
  });

  // Bulk-clean errored/building app entries
  app.post("/api/apps/cleanup", async (req, res) => {
    const allApps = appStore.getAll();
    const orphans = allApps.filter(a => a.status === "error" || a.status === "building");
    let cleaned = 0;
    for (const app2 of orphans) {
      try { await dockerManager.removeApp(app2.id); } catch {
        try { appStore.delete(app2.id); } catch { }
      }
      cleaned++;
    }
    res.json({ success: true, cleaned });
  });

  // ── Benchmarks ────────────────────────────────────────────────────
  app.get("/api/benchmarks", (req, res) => {
    res.json(benchmarkStore.getAllSuites());
  });

  app.get("/api/benchmarks/:id", (req, res) => {
    const suite = benchmarkStore.getSuiteById(parseInt(req.params.id));
    if (!suite) return res.status(404).json({ error: "Not found" });
    res.json(suite);
  });

  app.post("/api/benchmarks", (req, res) => {
    res.json(benchmarkStore.createSuite(req.body));
  });

  app.delete("/api/benchmarks/:id", (req, res) => {
    benchmarkStore.deleteSuite(parseInt(req.params.id));
    res.json({ success: true });
  });

  app.get("/api/benchmarks/:id/runs", (req, res) => {
    res.json(benchmarkStore.getRunsBySuite(parseInt(req.params.id)));
  });

  app.post("/api/benchmarks/:id/run", async (req, res) => {
    const suiteId = parseInt(req.params.id);
    const suite = benchmarkStore.getSuiteById(suiteId);
    if (!suite) return res.status(404).json({ error: "Suite not found" });

    const { modelId, endpointId } = req.body;
    const model = modelStore.getAll().find(m => m.modelId === modelId && m.endpointId === endpointId);
    const endpoint = endpointStore.getById(endpointId);
    if (!model || !endpoint) return res.status(400).json({ error: "Model or endpoint not found" });

    const run = benchmarkStore.createRun({
      suiteId,
      modelId,
      endpointId,
      status: "running",
    });

    // Run benchmark in background
    runBenchmark(run.id, suite, model, endpoint).catch(err => {
      console.error("[Benchmark] Error:", err);
      benchmarkStore.updateRun(run.id, { status: "failed" });
    });

    res.json(run);
  });

  app.patch("/api/benchmarks/runs/:id", (req, res) => {
    const updated = benchmarkStore.updateRun(parseInt(req.params.id), req.body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  });

  // ── Analytics ─────────────────────────────────────────────────────
  app.get("/api/analytics/overview", async (req, res) => {
    const days = parseInt(req.query.days as string) || 30;

    const dailyUsage = analyticsStore.getDailyUsage(days);
    const tokensByModelRaw = analyticsStore.getTokenUsageByModel();
    const taskTypeDistribution = analyticsStore.getTaskTypeDistribution();
    const avgResponseRaw = analyticsStore.getAverageResponseTime();

    // Compute summary from raw data
    const todayStr = new Date().toISOString().slice(0, 10);
    const todayUsage = dailyUsage.find(d => d.date === todayStr);
    const totalEventsToday = todayUsage?.events ?? 0;
    const totalTokensToday = todayUsage?.tokens ?? 0;
    const allAvgMs = avgResponseRaw.map(r => r.avgMs).filter(Boolean);
    const avgResponseTimeMs = allAvgMs.length
      ? Math.round(allAvgMs.reduce((a, b) => a + b, 0) / allAvgMs.length)
      : 0;
    const activeModels = tokensByModelRaw.length;

    // Reshape tokensByModel to { model, tokens, totalIn, totalOut }
    const tokensByModel = tokensByModelRaw.map(t => ({
      model: t.modelId,
      tokens: t.totalIn + t.totalOut,
      totalIn: t.totalIn,
      totalOut: t.totalOut,
    }));

    // Reshape avgResponse to { model, avgMs }
    const avgResponseByModel = avgResponseRaw.map(r => ({
      model: r.modelId,
      avgMs: Math.round(r.avgMs),
    }));

    // Efficiency metrics
    const efficiencyRaw = analyticsStore.getEfficiencyMetrics();
    const totalComputeHours = efficiencyRaw.totalDurationMs / 3600000;
    const successRate = efficiencyRaw.totalEvents > 0
      ? Math.round((efficiencyRaw.successEvents / efficiencyRaw.totalEvents) * 100)
      : 100;
    const totalTokens = efficiencyRaw.totalTokensIn + efficiencyRaw.totalTokensOut;
    const chatEvents = dailyUsage.reduce((sum, d) => sum + d.events, 0);
    const tokensPerConversation = chatEvents > 0 ? Math.round(totalTokens / chatEvents) : 0;
    const tokensPerToolCall = efficiencyRaw.toolCallEvents > 0
      ? Math.round(totalTokens / efficiencyRaw.toolCallEvents)
      : 0;
    const efficiencyMetrics = {
      totalComputeHours: parseFloat(totalComputeHours.toFixed(3)),
      successRate,
      tokensPerConversation,
      tokensPerToolCall,
      totalTokensIn: efficiencyRaw.totalTokensIn,
      totalTokensOut: efficiencyRaw.totalTokensOut,
    };

    // Docker status
    let dockerStatus: { ready: boolean; running: number; total: number } | undefined;
    try {
      const isReady = dockerManager.isReady();
      if (isReady) {
        const stats = await dockerManager.getContainerStats();
        dockerStatus = { ready: true, running: stats.running ?? 0, total: stats.total ?? 0 };
      } else {
        dockerStatus = { ready: false, running: 0, total: 0 };
      }
    } catch {
      dockerStatus = { ready: false, running: 0, total: 0 };
    }

    res.json({
      summary: { totalEventsToday, totalTokensToday, avgResponseTimeMs, activeModels },
      dailyUsage,
      tokensByModel,
      taskTypeDistribution,
      avgResponseByModel,
      dockerStatus,
      efficiencyMetrics,
    });
  });

  app.get("/api/analytics/events", (req, res) => {
    const limit = parseInt(req.query.limit as string) || 100;
    res.json(analyticsStore.getRecent(limit));
  });

  app.get("/api/analytics/token-usage", (req, res) => {
    const limit = parseInt(req.query.limit as string) || 20;
    const rows = analyticsStore.getTokenUsageByConversationJoined(limit);
    res.json(rows);
  });

  // ── Memory ────────────────────────────────────────────────────────
  app.get("/api/memory", (req, res) => {
    res.json(memoryStore.getAll());
  });

  app.post("/api/memory", (req, res) => {
    res.json(memoryStore.create(req.body));
  });

  app.post("/api/memory/search", (req, res) => {
    const { query } = req.body;
    res.json(memoryStore.search(query || ""));
  });

  app.patch("/api/memory/:id", (req, res) => {
    const updated = memoryStore.update(parseInt(req.params.id), req.body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  });

  app.delete("/api/memory/:id", (req, res) => {
    memoryStore.delete(parseInt(req.params.id));
    res.json({ success: true });
  });

  // ── Settings ──────────────────────────────────────────────────────
  app.get("/api/settings", (req, res) => {
    res.json(settingsStore.getAll());
  });

  // Keys that may only be changed via their own dedicated UI endpoints, not by the
  // general settings PATCH. This prevents the agent from flipping selfDevEnabled
  // from inside a tool call (e.g. via selfdev_http_test → PATCH /api/settings).
  const SETTINGS_UI_ONLY_KEYS = new Set(["selfDevEnabled"]);

  app.patch("/api/settings", (req, res) => {
    for (const [key, value] of Object.entries(req.body)) {
      if (SETTINGS_UI_ONLY_KEYS.has(key)) {
        // Silently skip — this key can only be toggled from the Settings page directly
        continue;
      }
      settingsStore.set(key, String(value));
    }
    res.json(settingsStore.getAll());
  });

  // Dedicated endpoint for the Self-Development toggle. Separate from the
  // general PATCH so that selfDevEnabled cannot be flipped from inside an
  // agent tool call (see SETTINGS_UI_ONLY_KEYS above).
  app.post("/api/settings/self-dev-enabled", (req, res) => {
    const { enabled } = req.body ?? {};
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be a boolean" });
    }
    settingsStore.set("selfDevEnabled", String(enabled));
    res.json({ selfDevEnabled: String(enabled) });
  });

  // ── OpenRouter balance ──────────────────────────────────────────
  app.get("/api/endpoints/:id/openrouter-balance", async (req, res) => {
    const endpoint = endpointStore.getById(parseInt(req.params.id));
    if (!endpoint) return res.status(404).json({ error: "Not found" });
    if (endpoint.providerType !== "openrouter" || !endpoint.apiKey) {
      return res.status(400).json({ error: "Not an OpenRouter endpoint or missing API key" });
    }
    try {
      const r = await fetch("https://openrouter.ai/api/v1/credits", {
        headers: { Authorization: `Bearer ${endpoint.apiKey}` },
      });
      if (!r.ok) return res.status(r.status).json({ error: "OpenRouter returned " + r.status });
      const data = await r.json();
      const { total_credits = 0, total_usage = 0 } = data.data ?? {};
      res.json({ balance: total_credits - total_usage, total: total_credits, used: total_usage });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── DB / Storage path ───────────────────────────────────────────
  /** Returns the active DB path and the pending override (from sidecar file, if any) */
  app.get("/api/settings/db-path", (req, res) => {
    const sidecarPath = path.join(process.cwd(), "data", "db-path.txt");
    const pending = fs.existsSync(sidecarPath) ? fs.readFileSync(sidecarPath, "utf8").trim() : "";
    res.json({ active: DB_PATH, pending });
  });

  /** Write a new DB path to the sidecar file — takes effect on next restart */
  app.post("/api/settings/db-path", (req, res) => {
    const { dbPath } = req.body;
    const sidecarPath = path.join(process.cwd(), "data", "db-path.txt");
    if (!dbPath || !dbPath.trim()) {
      // Clear override — delete sidecar
      if (fs.existsSync(sidecarPath)) fs.unlinkSync(sidecarPath);
      return res.json({ ok: true, message: "DB path cleared — will use default on next restart" });
    }
    fs.writeFileSync(sidecarPath, dbPath.trim(), "utf8");
    res.json({ ok: true, message: "DB path saved — restart Agent2077 to apply" });
  });

  // ── Docker status ─────────────────────────────────────────────────
  app.get("/api/docker/status", async (req, res) => {
    const stats = await dockerManager.getContainerStats();
    res.json({ ready: dockerManager.isReady(), ...stats });
  });

  // ── Console / Logs ────────────────────────────────────────────────
  app.get("/api/console/logs", (req, res) => {
    const limit = parseInt(req.query.limit as string) || 200;
    const afterId = req.query.afterId ? parseInt(req.query.afterId as string) : undefined;
    res.json(getRecentLogs(limit, afterId));
  });

  app.get("/api/console/stream", (req: AuthRequest, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    // Send recent logs first as a batch
    const recent = getRecentLogs(100);
    for (const entry of recent) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    addLogClient(res);

    req.on("close", () => {
      removeLogClient(res);
    });
  });

  // ── LLM Inspector ────────────────────────────────────────────────
  app.get("/api/inspector/logs", (req, res) => {
    const limit = Math.min(parseInt((req.query as any).limit ?? "20", 10), 50);
    res.json(getRecentInspectorEntries(limit));
  });

  app.get("/api/inspector/stream", (req: AuthRequest, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    // Send recent entries first as a catch-up batch
    const recent = getRecentInspectorEntries(50);
    for (const entry of recent) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    addInspectorClient(res);

    req.on("close", () => {
      removeInspectorClient(res);
    });
  });

  // ── SearXNG test ──────────────────────────────────────────────────
  app.post("/api/search/test", async (req, res) => {
    const url = req.body.url || settingsStore.get("searxng.url");
    try {
      const testRes = await fetch(`${url}/search?q=test&format=json&count=1`, { signal: AbortSignal.timeout(5000) });
      res.json({ success: testRes.ok });
    } catch (err: any) {
      res.json({ success: false, error: err.message });
    }
  });

  // ── Chat Groups ───────────────────────────────────────────────────
  app.get("/api/chat-groups", (req, res) => {
    res.json(chatGroupStore.getAll());
  });

  app.post("/api/chat-groups", (req, res) => {
    res.json(chatGroupStore.create(req.body));
  });

  app.put("/api/chat-groups/:id", (req, res) => {
    const updated = chatGroupStore.update(parseInt(req.params.id), req.body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  });

  app.delete("/api/chat-groups/:id", (req, res) => {
    chatGroupStore.delete(parseInt(req.params.id));
    res.json({ success: true });
  });

  // ── Bulk conversation delete ───────────────────────────────────────
  app.post("/api/conversations/bulk-delete", (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every(id => typeof id === "number")) {
      return res.status(400).json({ error: "ids must be a non-empty array of numbers" });
    }
    conversationStore.bulkDelete(ids);
    res.json({ success: true, deleted: ids.length });
  });

  // ── Conversation group assignment ─────────────────────────────────
  app.put("/api/conversations/:id/group", (req, res) => {
    const id = parseInt(req.params.id);
    const { groupId } = req.body;
    // groupId can be null (ungroup) or a valid group id
    const updated = conversationStore.update(id, { groupId: groupId ?? null });
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  });

  // ── Projects ──────────────────────────────────────────────────────
  app.get("/api/projects", (req, res) => {
    res.json(projectStore.getAll());
  });

  app.post("/api/projects", async (req, res) => {
    try {
      const { name, description, path: projectPath, language } = req.body;
      if (!name) return res.status(400).json({ error: "name is required" });

      // Determine project directory path — use configured root (or ~/projects default)
      const projectsRoot = getProjectsRoot();
      if (!fs.existsSync(projectsRoot)) fs.mkdirSync(projectsRoot, { recursive: true });

      const resolvedPath = projectPath || path.join(projectsRoot, name.toLowerCase().replace(/[^a-z0-9]+/g, "-"));

      // Create the project directory if it doesn't exist
      if (!fs.existsSync(resolvedPath)) fs.mkdirSync(resolvedPath, { recursive: true });

      // Create dedicated conversation for the project (with placeholder prompt)
      const conv = conversationStore.create({
        title: `[Project] ${name}`,
        systemPrompt: `(placeholder)`,
      });

      const project = projectStore.create({
        name,
        description: description || null,
        path: resolvedPath,
        language: language || null,
        conversationId: conv.id,
        status: "active",
      });

      // Now update the conversation's system prompt with the full project-scoped instructions
      // including the real project ID so the tools work correctly
      const fullProjectPrompt =
        `## CRITICAL — PROJECT CONTEXT\n` +
        `You are working inside the project "${name}" (projectId: ${project.id}).\n` +
        `The project is located at: ${resolvedPath}\n\n` +
        `## MANDATORY TOOL USAGE\n` +
        `You MUST use these project-specific tools (with projectId: ${project.id}):\n` +
        `- write_project_file(projectId: ${project.id}, filePath: "relative/path", content: "...") — to create or write files\n` +
        `- read_project_file(projectId: ${project.id}, filePath: "relative/path") — to read files\n` +
        `- edit_project_file(projectId: ${project.id}, filePath: "relative/path", oldText: "...", newText: "...") — to edit files\n` +
        `- list_project_files(projectId: ${project.id}) — to list project files\n` +
        `- run_project_command(projectId: ${project.id}, command: "...") — to run shell commands in the project directory\n\n` +
        `## FORBIDDEN — DO NOT USE THESE\n` +
        `- Do NOT use write_file or read_file (those write to the wrong directory)\n` +
        `- Do NOT use deploy_app (that deploys to the App Store, not the project)\n` +
        `- Do NOT use shell_command or execute_code\n` +
        `- File paths in write_project_file/read_project_file should be RELATIVE to the project root (e.g. "index.html", "src/app.js"), NOT absolute paths.\n\n` +
        `## EDITING EXISTING FILES\n` +
        `When modifying existing code, ALWAYS use read_project_file FIRST to see the current content, then use edit_project_file with the EXACT text to replace. Do NOT guess what the file contains.\n`;
      conversationStore.update(conv.id, { systemPrompt: fullProjectPrompt });

      res.json(project);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/projects/:id", (req, res) => {
    const project = projectStore.getById(parseInt(req.params.id));
    if (!project) return res.status(404).json({ error: "Project not found" });
    res.json(project);
  });

  app.put("/api/projects/:id", (req, res) => {
    const updated = projectStore.update(parseInt(req.params.id), req.body);
    if (!updated) return res.status(404).json({ error: "Project not found" });
    res.json(updated);
  });

  app.delete("/api/projects/:id", (req, res) => {
    projectStore.delete(parseInt(req.params.id));
    res.json({ success: true });
  });

  // ── Project file tree ─────────────────────────────────────────────
  app.get("/api/projects/:id/files", (req, res) => {
    const project = projectStore.getById(parseInt(req.params.id));
    if (!project) return res.status(404).json({ error: "Project not found" });
    const tree = buildFileTree(project.path);
    res.json(tree);
  });

  // ── Project file read ─────────────────────────────────────────────
  app.get("/api/projects/:id/file", (req, res) => {
    const project = projectStore.getById(parseInt(req.params.id));
    if (!project) return res.status(404).json({ error: "Project not found" });

    const filePath = req.query.path as string;
    if (!filePath) return res.status(400).json({ error: "path query param required" });

    const fullPath = path.join(project.path, filePath);
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(project.path))) {
      return res.status(403).json({ error: "Path traversal not allowed" });
    }

    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: "File not found" });

    const content = fs.readFileSync(fullPath, "utf-8");
    res.json({ path: filePath, content });
  });

  // ── Project file write/update ─────────────────────────────────────
  app.put("/api/projects/:id/file", (req, res) => {
    const project = projectStore.getById(parseInt(req.params.id));
    if (!project) return res.status(404).json({ error: "Project not found" });

    const { path: filePath, content } = req.body;
    if (!filePath) return res.status(400).json({ error: "path is required" });

    const fullPath = path.join(project.path, filePath);
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(project.path))) {
      return res.status(403).json({ error: "Path traversal not allowed" });
    }

    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content ?? "", "utf-8");
    projectStore.update(project.id, { lastOpenedFile: filePath });
    res.json({ success: true, path: filePath });
  });

  // ── Project file create ───────────────────────────────────────────
  app.post("/api/projects/:id/file", (req, res) => {
    const project = projectStore.getById(parseInt(req.params.id));
    if (!project) return res.status(404).json({ error: "Project not found" });

    const { path: filePath, content } = req.body;
    if (!filePath) return res.status(400).json({ error: "path is required" });

    const fullPath = path.join(project.path, filePath);
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(project.path))) {
      return res.status(403).json({ error: "Path traversal not allowed" });
    }

    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content ?? "", "utf-8");
    res.json({ success: true, path: filePath });
  });

  // ── Project file delete ───────────────────────────────────────────
  app.delete("/api/projects/:id/file", (req, res) => {
    const project = projectStore.getById(parseInt(req.params.id));
    if (!project) return res.status(404).json({ error: "Project not found" });

    const filePath = (req.query.path as string) || req.body?.path;
    if (!filePath) return res.status(400).json({ error: "path is required" });

    const fullPath = path.join(project.path, filePath);
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(project.path))) {
      return res.status(403).json({ error: "Path traversal not allowed" });
    }

    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: "File not found" });
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(fullPath);
    }
    res.json({ success: true });
  });

  // ── Project folder create ─────────────────────────────────────────
  app.post("/api/projects/:id/folder", (req, res) => {
    const project = projectStore.getById(parseInt(req.params.id));
    if (!project) return res.status(404).json({ error: "Project not found" });

    const { path: folderPath } = req.body;
    if (!folderPath) return res.status(400).json({ error: "path is required" });

    const fullPath = path.join(project.path, folderPath);
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(project.path))) {
      return res.status(403).json({ error: "Path traversal not allowed" });
    }

    fs.mkdirSync(fullPath, { recursive: true });
    res.json({ success: true, path: folderPath });
  });

  // ── Project folder delete ─────────────────────────────────────────
  app.delete("/api/projects/:id/folder", (req, res) => {
    const project = projectStore.getById(parseInt(req.params.id));
    if (!project) return res.status(404).json({ error: "Project not found" });

    const folderPath = (req.query.path as string) || req.body?.path;
    if (!folderPath) return res.status(400).json({ error: "path is required" });

    const fullPath = path.join(project.path, folderPath);
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(project.path))) {
      return res.status(403).json({ error: "Path traversal not allowed" });
    }

    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: "Folder not found" });
    fs.rmSync(fullPath, { recursive: true, force: true });
    res.json({ success: true });
  });

  // ── Project rename ────────────────────────────────────────────────
  app.post("/api/projects/:id/rename", (req, res) => {
    const project = projectStore.getById(parseInt(req.params.id));
    if (!project) return res.status(404).json({ error: "Project not found" });

    const { oldPath, newPath } = req.body;
    if (!oldPath || !newPath) return res.status(400).json({ error: "oldPath and newPath are required" });

    const fullOldPath = path.join(project.path, oldPath);
    const fullNewPath = path.join(project.path, newPath);
    const resolvedOld = path.resolve(fullOldPath);
    const resolvedNew = path.resolve(fullNewPath);
    if (!resolvedOld.startsWith(path.resolve(project.path)) || !resolvedNew.startsWith(path.resolve(project.path))) {
      return res.status(403).json({ error: "Path traversal not allowed" });
    }

    if (!fs.existsSync(fullOldPath)) return res.status(404).json({ error: "Source not found" });
    fs.mkdirSync(path.dirname(fullNewPath), { recursive: true });
    fs.renameSync(fullOldPath, fullNewPath);
    res.json({ success: true, oldPath, newPath });
  });

  // ── Project file upload ────────────────────────────────────────
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 200 } }); // 50MB max

  app.post("/api/projects/:id/upload", upload.array("files", 200), (req, res) => {
    try {
      const project = projectStore.getById(parseInt(req.params.id));
      if (!project) return res.status(404).json({ error: "Project not found" });

      const targetDir = (req.body.directory || "").replace(/\.\.\//g, "");
      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) return res.status(400).json({ error: "No files provided" });

      // relativePaths: JSON array of relative paths (e.g. ["folder/file.js", "folder/sub/utils.js"])
      // Sent by the client when uploading a folder via webkitdirectory.
      let relativePaths: string[] = [];
      try {
        if (req.body.relativePaths) relativePaths = JSON.parse(req.body.relativePaths);
      } catch {}

      const uploaded: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        // Use relativePath if provided (folder upload), otherwise just filename
        const relPath = relativePaths[i] ? relativePaths[i].replace(/\.\.\//g, "") : file.originalname;

        const baseDir = targetDir
          ? path.join(project.path, targetDir)
          : project.path;

        // Full dest including any subdirectory structure from the folder
        const destPath = path.join(baseDir, relPath);
        const destDir = path.dirname(destPath);

        // Security: ensure resolved path is within the project
        const resolvedDest = path.resolve(destPath);
        if (!resolvedDest.startsWith(path.resolve(project.path))) {
          return res.status(403).json({ error: "Path traversal not allowed" });
        }

        fs.mkdirSync(destDir, { recursive: true });
        fs.writeFileSync(destPath, file.buffer);
        uploaded.push(relPath);
      }

      res.json({ success: true, uploaded });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Project run (SSE streaming) ────────────────────────────────────
  app.post("/api/projects/:id/run", async (req, res) => {
    const project = projectStore.getById(parseInt(req.params.id));
    if (!project) return res.status(404).json({ error: "Project not found" });

    const { command } = req.body;
    if (!command) return res.status(400).json({ error: "Command required" });

    // SSE for streaming output
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const proc = spawn("bash", ["-c", command], {
      cwd: project.path,
      env: { ...process.env, HOME: process.env.HOME || "/root" },
    });

    let finished = false;

    proc.stdout.on("data", (data) => {
      if (!finished) res.write(`data: ${JSON.stringify({ type: "stdout", content: data.toString() })}\n\n`);
    });

    proc.stderr.on("data", (data) => {
      if (!finished) res.write(`data: ${JSON.stringify({ type: "stderr", content: data.toString() })}\n\n`);
    });

    proc.on("close", (code) => {
      if (!finished) {
        finished = true;
        res.write(`data: ${JSON.stringify({ type: "exit", code })}\n\n`);
        res.end();
      }
    });

    proc.on("error", (err) => {
      if (!finished) {
        finished = true;
        res.write(`data: ${JSON.stringify({ type: "error", content: err.message })}\n\n`);
        res.end();
      }
    });

    // Kill process if client disconnects (response stream closed)
    res.on("close", () => {
      if (!finished) {
        finished = true;
        proc.kill();
      }
    });
  });

  // ── Project download as tar.gz ────────────────────────────────────
  app.get("/api/projects/:id/download", (req, res) => {
    const project = projectStore.getById(parseInt(req.params.id));
    if (!project) return res.status(404).json({ error: "Project not found" });

    const projectDir = project.path;
    const projectName = path.basename(projectDir);

    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="${projectName}.tar.gz"`);

    const proc = spawn("tar", [
      "czf", "-",
      "--exclude=node_modules", "--exclude=.git", "--exclude=__pycache__",
      "--exclude=.venv", "--exclude=venv",
      "-C", path.dirname(projectDir),
      projectName,
    ]);

    proc.stdout.pipe(res);
    proc.stderr.on("data", (data) => console.warn("[Download]", data.toString()));
    proc.on("error", (err) => {
      if (!res.headersSent) res.status(500).json({ error: err.message });
    });
  });

  // ── Project import to App Store ───────────────────────────────────
  app.post("/api/projects/:id/import-to-app", async (req, res) => {
    const project = projectStore.getById(parseInt(req.params.id));
    if (!project) return res.status(404).json({ error: "Project not found" });

    try {
      const port = appStore.getNextPort();
      let internalPort = req.body.port || 3000;
      const buildPath = project.path;

      // ── Detect project type and generate Dockerfile if one doesn't exist ──
      const existingDockerfile = fs.existsSync(path.join(buildPath, "Dockerfile"))
        ? fs.readFileSync(path.join(buildPath, "Dockerfile"), "utf8")
        : null;

      let dockerfileContent = existingDockerfile;

      // If an existing Dockerfile is present, sniff the EXPOSE port and use it
      // as internalPort (unless the caller explicitly supplied req.body.port)
      if (existingDockerfile && !req.body.port) {
        const exposeMatch = existingDockerfile.match(/^EXPOSE\s+(\d+)/mi);
        if (exposeMatch) {
          internalPort = parseInt(exposeMatch[1], 10);
          console.log(`[ImportApp] Detected EXPOSE ${internalPort} from existing Dockerfile`);
        }
      }

      if (!dockerfileContent) {
        const hasPackageJson = fs.existsSync(path.join(buildPath, "package.json"));
        const hasRequirements = fs.existsSync(path.join(buildPath, "requirements.txt"));
        const hasPyproject = fs.existsSync(path.join(buildPath, "pyproject.toml"));
        const hasIndexHtml = fs.existsSync(path.join(buildPath, "index.html"));
        const hasIndexPy = fs.existsSync(path.join(buildPath, "index.py")) || fs.existsSync(path.join(buildPath, "main.py")) || fs.existsSync(path.join(buildPath, "app.py"));

        if (hasPackageJson) {
          // Read package.json to detect start script
          let startScript = "node index.js";
          try {
            const pkg = JSON.parse(fs.readFileSync(path.join(buildPath, "package.json"), "utf8"));
            if (pkg.scripts?.start) startScript = "npm start";
            else if (pkg.main) startScript = `node ${pkg.main}`;
          } catch {}

          dockerfileContent = `FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE ${internalPort}
CMD ["sh", "-c", "${startScript}"]`;
        } else if (hasRequirements || hasPyproject || hasIndexPy) {
          const mainFile = fs.existsSync(path.join(buildPath, "main.py")) ? "main.py"
            : fs.existsSync(path.join(buildPath, "app.py")) ? "app.py"
            : "index.py";
          dockerfileContent = `FROM python:3.12-slim
WORKDIR /app
COPY ${hasRequirements ? "requirements.txt ./" : ""}
${hasRequirements ? "RUN pip install --no-cache-dir -r requirements.txt" : ""}
COPY . .
EXPOSE ${internalPort}
CMD ["python", "${mainFile}"]`;
        } else if (hasIndexHtml) {
          // Static site — serve with nginx on port 80
          internalPort = 80; // nginx listens on 80 — must match the port binding
          dockerfileContent = `FROM nginx:alpine
COPY . /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]`;
        } else {
          // Fallback: generic node
          dockerfileContent = `FROM node:22-slim
WORKDIR /app
COPY . .
EXPOSE ${internalPort}
CMD ["node", "index.js"]`;
        }
      }

      // Create app DB record
      const newApp = appStore.create({
        name: project.name,
        description: project.description || `Imported from project: ${project.name}`,
        category: req.body.category || "tool",
        imageName: `agent2077-app-${project.id}`,
        buildPath,
        dockerfile: dockerfileContent,
        iconEmoji: req.body.iconEmoji || "🔧",
        internalPort,
        port,
      });

      // ── Build + launch Docker container if Docker is available ──
      // deployApp() handles build AND container.start() internally — no need to call startApp() after.
      if (dockerManager.isReady()) {
        try {
          await dockerManager.deployApp(newApp.id, dockerfileContent, buildPath, port, internalPort);
          console.log(`[ImportApp] Docker container built and started for app ${newApp.id} on port ${port}`);
        } catch (dockerErr: any) {
          // Don't fail the import — the app record exists, Docker can be retried via the App Store UI
          console.warn(`[ImportApp] Docker build/start failed for app ${newApp.id}:`, dockerErr.message);
          appStore.update(newApp.id, { notes: `Docker build failed: ${dockerErr.message}` } as any);
        }
      } else {
        console.warn(`[ImportApp] Docker not available — app ${newApp.id} created but not started`);
      }

      res.json(newApp);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── MCP Servers ─────────────────────────────────────────────────────
  app.get("/api/mcp-servers", (req, res) => {
    try {
      res.json(mcpServerStore.getAll());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/mcp-servers", (req, res) => {
    try {
      const server = mcpServerStore.create(req.body);
      res.json(server);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/mcp-servers/:id", (req, res) => {
    const server = mcpServerStore.getById(parseInt(req.params.id));
    if (!server) return res.status(404).json({ error: "Not found" });
    res.json(server);
  });

  app.patch("/api/mcp-servers/:id", (req, res) => {
    try {
      const updated = mcpServerStore.update(parseInt(req.params.id), req.body);
      if (!updated) return res.status(404).json({ error: "Not found" });
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/mcp-servers/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      await disconnectMcpServer(id);
      mcpServerStore.delete(id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/mcp-servers/:id/connect", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      await connectMcpServer(id);
      const updated = mcpServerStore.getById(id);
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/mcp-servers/:id/disconnect", async (req, res) => {
    try {
      await disconnectMcpServer(parseInt(req.params.id));
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/mcp-servers/:id/tools", (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const server = mcpServerStore.getById(id);
      if (!server) return res.status(404).json({ error: "Not found" });
      const tools = getMcpServerTools(id);
      res.json(tools);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Git Routes ──────────────────────────────────────────────────────────
  function runGit(projectPath: string, gitArgs: string): { output: string; success: boolean } {
    try {
      const output = execSync(`git ${gitArgs}`, {
        cwd: projectPath,
        timeout: 30000,
        maxBuffer: 1024 * 1024 * 2,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: process.env.HOME || "/root",
          GIT_AUTHOR_NAME: "Agent2077",
          GIT_AUTHOR_EMAIL: "agent@agent2077.local",
          GIT_COMMITTER_NAME: "Agent2077",
          GIT_COMMITTER_EMAIL: "agent@agent2077.local",
        },
      });
      return { output: output || "(no output)", success: true };
    } catch (err: any) {
      return {
        success: false,
        output: `${err.stderr || ""} ${err.stdout || ""}`.trim() || err.message,
      };
    }
  }

  app.get("/api/projects/:id/git/status", (req, res) => {
    const project = projectStore.getById(parseInt(req.params.id));
    if (!project) return res.status(404).json({ error: "Project not found" });
    res.json(runGit(project.path, "status"));
  });

  app.get("/api/projects/:id/git/log", (req, res) => {
    const project = projectStore.getById(parseInt(req.params.id));
    if (!project) return res.status(404).json({ error: "Project not found" });
    const limit = parseInt(req.query.limit as string) || 20;
    res.json(runGit(project.path, `log --oneline --graph -${Math.min(limit, 100)}`));
  });

  app.get("/api/projects/:id/git/diff", (req, res) => {
    const project = projectStore.getById(parseInt(req.params.id));
    if (!project) return res.status(404).json({ error: "Project not found" });
    const staged = req.query.staged === "true";
    res.json(runGit(project.path, staged ? "diff --staged" : "diff"));
  });

  app.get("/api/projects/:id/git/branches", (req, res) => {
    const project = projectStore.getById(parseInt(req.params.id));
    if (!project) return res.status(404).json({ error: "Project not found" });
    res.json(runGit(project.path, "branch -v"));
  });

  app.post("/api/projects/:id/git/init", (req, res) => {
    const project = projectStore.getById(parseInt(req.params.id));
    if (!project) return res.status(404).json({ error: "Project not found" });
    res.json(runGit(project.path, "init"));
  });

  app.post("/api/projects/:id/git/commit", (req, res) => {
    const project = projectStore.getById(parseInt(req.params.id));
    if (!project) return res.status(404).json({ error: "Project not found" });
    const { message, files } = req.body;
    if (!message) return res.status(400).json({ error: "message required" });
    const filesToStage = String(files || ".").replace(/[`$\\]/g, "");
    const addResult = runGit(project.path, `add ${filesToStage}`);
    if (!addResult.success) return res.json(addResult);
    const safeMsg = String(message).replace(/"/g, '\\"');
    res.json(runGit(project.path, `commit -m "${safeMsg}"`));
  });

  app.post("/api/projects/:id/git/checkout", (req, res) => {
    const project = projectStore.getById(parseInt(req.params.id));
    if (!project) return res.status(404).json({ error: "Project not found" });
    const { branch } = req.body;
    if (!branch) return res.status(400).json({ error: "branch required" });
    const safeBranch = String(branch).replace(/[^a-zA-Z0-9/_.-]/g, "-");
    res.json(runGit(project.path, `checkout ${safeBranch}`));
  });

  app.post("/api/projects/:id/git/stash", (req, res) => {
    const project = projectStore.getById(parseInt(req.params.id));
    if (!project) return res.status(404).json({ error: "Project not found" });
    const action = req.body.action || "list";
    const safeAction = ["push", "pop", "list"].includes(action) ? action : "list";
    res.json(runGit(project.path, `stash ${safeAction}`));
  });

  // ── Background Tasks ─────────────────────────────────────────────────────
  app.get("/api/background-tasks", (req, res) => {
    try {
      const { status } = req.query;
      const tasks = status
        ? backgroundTaskStore.getByStatus(status as string)
        : backgroundTaskStore.getAll();
      res.json(tasks);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/background-tasks", (req, res) => {
    try {
      const { title, description, type, cronExpression, modelId, endpointId } = req.body;
      if (!title) return res.status(400).json({ error: "title required" });

      const task = backgroundTaskStore.create({
        title,
        description: description || null,
        type: type || "one-shot",
        cronExpression: cronExpression || null,
        modelId: modelId || null,
        endpointId: endpointId || null,
        status: "queued",
      });

      // For one-shot tasks, enqueue immediately
      if (task.type === "one-shot") {
        enqueueTask(task.id);
      }

      res.json(task);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/background-tasks/:id", (req, res) => {
    const task = backgroundTaskStore.getById(parseInt(req.params.id));
    if (!task) return res.status(404).json({ error: "Not found" });
    const logs = task.logs ? JSON.parse(task.logs) : [];
    res.json({ ...task, logs });
  });

  app.post("/api/background-tasks/:id/cancel", (req, res) => {
    try {
      cancelTask(parseInt(req.params.id));
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/background-tasks/:id", (req, res) => {
    try {
      backgroundTaskStore.delete(parseInt(req.params.id));
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/background-tasks/:id/retry", (req, res) => {
    try {
      retryTask(parseInt(req.params.id));
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Terminal sessions REST ───────────────────────────────────────────────────
  app.get("/api/projects/:id/terminal/sessions", (req, res) => {
    try {
      const projectId = parseInt(req.params.id);
      const project = projectStore.getById(projectId);
      if (!project) return res.status(404).json({ error: "Project not found" });
      res.json(listTerminalSessions(projectId));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/projects/:id/terminal/sessions", (req, res) => {
    try {
      const project = projectStore.getById(parseInt(req.params.id));
      if (!project) return res.status(404).json({ error: "Project not found" });
      const session = createTerminalSession(project.id, project.path);
      res.json({ ...session, wsUrl: `/ws/terminal/${session.sessionId}` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Diff / propose-edit routes ───────────────────────────────────────────────

  // GET /api/edits/pending — list all pending edits
  app.get("/api/edits/pending", (req, res) => {
    try {
      const pending = Array.from(pendingEdits.values()).filter(e => e.status === "pending");
      res.json(pending);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/edits/:id/approve — approve and apply a pending edit
  app.post("/api/edits/:id/approve", async (req, res) => {
    try {
      const edit = pendingEdits.get(req.params.id);
      if (!edit) return res.status(404).json({ error: "Edit not found" });
      if (edit.status !== "pending") {
        return res.status(400).json({ error: `Edit is already ${edit.status}` });
      }

      const { projectStore } = await import("./storage.js");
      const project = projectStore.getById(edit.projectId);
      if (!project) return res.status(404).json({ error: "Project not found" });

      const fullPath = path.join(project.path, edit.filePath);
      const resolved = path.resolve(fullPath);
      if (!resolved.startsWith(path.resolve(project.path))) {
        return res.status(400).json({ error: "Path traversal not allowed" });
      }

      // Ensure parent directory exists
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      fs.writeFileSync(fullPath, edit.proposedContent, "utf-8");
      edit.status = "approved";
      pendingEdits.set(edit.id, edit);

      res.json({ success: true, editId: edit.id, filePath: edit.filePath });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/edits/:id/reject — reject a pending edit
  app.post("/api/edits/:id/reject", (req, res) => {
    try {
      const edit = pendingEdits.get(req.params.id);
      if (!edit) return res.status(404).json({ error: "Edit not found" });
      if (edit.status !== "pending") {
        return res.status(400).json({ error: `Edit is already ${edit.status}` });
      }

      edit.status = "rejected";
      pendingEdits.set(edit.id, edit);

      res.json({ success: true, editId: edit.id, filePath: edit.filePath });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  // ── Reset Permissions ──────────────────────────────────────────────────────

  // GET /api/self-dev/reset-permissions — list pending reset permission requests
  app.get("/api/self-dev/reset-permissions", (req, res) => {
    const pending = Array.from(pendingResetPermissions.values())
      .filter(p => p.status === "pending" && !p.usedAt);
    res.json(pending);
  });

  /**
   * Shared helper — inject a user message into the self-dev conversation and
   * fire-and-forget a new agent loop turn. Used by both approve and deny so
   * the agent always gets a chance to react and keep working.
   */
  async function resumeSelfDevAgent(resumeMsg: string): Promise<void> {
    const selfDevConvIdStr = settingsStore.get("selfDevConversationId");
    if (!selfDevConvIdStr) {
      console.warn("[SelfDev] resumeSelfDevAgent: no selfDevConversationId set");
      return;
    }
    const convId = parseInt(selfDevConvIdStr);
    const conv = conversationStore.getById(convId);
    if (!conv) {
      console.warn("[SelfDev] resumeSelfDevAgent: conversation", convId, "not found");
      return;
    }

    // Build a fresh self-dev system prompt (same as /api/self-dev/chat)
    const info = getDevInfo();
    const archContent = info.devDir ? await readDevFile("ARCHITECTURE.md") : null;
    let knownIssues: string | null = null;
    try {
      const kiPath = path.join(DEV_BASE, "KNOWN_ISSUES.md");
      if (fs.existsSync(kiPath)) knownIssues = fs.readFileSync(kiPath, "utf-8");
    } catch {}
    const devLog = info.devDir ? await readDevFile("DEV_LOG.md") : null;
    const sessionSummary = info.devDir ? await readDevFile("SESSION_SUMMARY.md") : null;
    const selfDevCodingModel = settingsStore.get("selfDevCodingModel") || undefined;
    const systemPrompt = buildSelfDevPrompt({
      devDir: info.devDir,
      stableDir: info.stableDir,
      devNumber: info.devNumber,
      architectureContent: archContent,
      knownIssuesContent: knownIssues,
      devLogContent: devLog,
      sessionSummary,
      configuredModels: { coding: selfDevCodingModel },
      lastBuildResult: info.lastBuild,
      lastTestResult: info.lastTests,
    });

    messageStore.create({ conversationId: convId, role: "user", content: resumeMsg });

    const autoRouting = settingsStore.get("autoRouting") !== "false";
    const routing = await routeMessage(resumeMsg, autoRouting, convId);
    if (!routing) {
      console.warn("[SelfDev] resumeSelfDevAgent: no routing available");
      return;
    }

    const requestId = uuid();
    const agentStream = getOrCreateStream(convId, requestId);
    const streamWriter = createStreamWriter(agentStream);

    // Broadcast wrapper — client SSE subscriptions will receive events
    const originalWrite = agentStream.write.bind(agentStream);
    agentStream.write = function(sseData: string): boolean {
      const result = originalWrite(sseData);
      broadcast(convId, sseData);
      return result;
    };

    // Send request_id so the client can track this new turn
    agentStream.write(`data: ${JSON.stringify({ type: "request_id", requestId })}\n\n`);

    // Build full message history
    const historyMsgs = messageStore.getByConversation(convId);
    const chatMessages = historyMsgs.map((m) => ({
      role: m.role as "user" | "assistant" | "system",
      content: m.content || "",
    }));

    markActive(convId);
    runAgentLoop({
      conversationId: convId,
      messages: chatMessages,
      model: routing.model,
      endpoint: routing.endpoint,
      taskType: routing.taskType,
      res: streamWriter,
      requestId,
      systemPrompt,
    }).catch((err: unknown) => {
      console.error("[SelfDev] Error resuming agent after reset decision:", err);
    }).finally(() => {
      markInactive(convId);
      try { agentStream.end(); } catch { /* already ended */ }
    });
  }

  // POST /api/self-dev/reset-permissions/:id/approve
  app.post("/api/self-dev/reset-permissions/:id/approve", async (req, res) => {
    const p = pendingResetPermissions.get(req.params.id);
    if (!p) return res.status(404).json({ error: "Permission request not found or expired" });
    if (p.usedAt) return res.status(400).json({ error: "Token already used" });
    if (p.status !== "pending") return res.status(400).json({ error: `Already ${p.status}` });
    p.status = "approved";
    pendingResetPermissions.set(p.id, p);
    res.json({ success: true, id: p.id, type: p.type, filePath: p.filePath });

    // Resume agent after response is sent — fire-and-forget
    const resumeMsg = p.type === "all"
      ? `Permission approved. Please proceed with selfdev_reset_all using permissionToken: "${p.id}".`
      : `Permission approved. Please proceed with selfdev_reset_file for '${p.filePath}' using permissionToken: "${p.id}".`;
    resumeSelfDevAgent(resumeMsg).catch((err) =>
      console.error("[SelfDev] Failed to resume after approve:", err)
    );
  });

  // POST /api/self-dev/reset-permissions/:id/deny
  app.post("/api/self-dev/reset-permissions/:id/deny", async (req, res) => {
    const p = pendingResetPermissions.get(req.params.id);
    if (!p) return res.status(404).json({ error: "Permission request not found or expired" });
    if (p.usedAt) return res.status(400).json({ error: "Token already used" });
    p.status = "denied";
    pendingResetPermissions.set(p.id, p);
    res.json({ success: true, id: p.id });

    // Inform the agent so it can decide how to proceed (skip reset, try alternative, etc.)
    const denyMsg = p.type === "all"
      ? `Reset permission was denied. Do NOT proceed with selfdev_reset_all. Continue working without resetting — find another approach to fix the problem.`
      : `Reset permission was denied for '${p.filePath}'. Do NOT reset that file. Continue working without that reset — find another approach.`;
    resumeSelfDevAgent(denyMsg).catch((err) =>
      console.error("[SelfDev] Failed to resume after deny:", err)
    );
  });

  // ── ComfyUI / Image Generation ─────────────────────────────────

  // GET /api/comfyui/status — check ComfyUI connection
  app.get("/api/comfyui/status", async (req, res) => {
    try {
      const status = await comfyCheckConnection();
      res.json(status);
    } catch (err: any) {
      res.json({ connected: false, error: err.message });
    }
  });

  // GET /api/comfyui/models — list installed ComfyUI models
  app.get("/api/comfyui/models", async (req, res) => {
    try {
      const mdls = await comfyListModels();
      res.json(mdls);
    } catch (err: any) {
      res.status(500).json({ error: `Cannot reach ComfyUI: ${err.message}` });
    }
  });

  // GET /api/comfyui/workflows — list saved workflows
  app.get("/api/comfyui/workflows", async (req, res) => {
    const workflows = workflowStore.getAll();
    res.json(workflows);
  });

  // POST /api/comfyui/workflows — save a workflow
  app.post("/api/comfyui/workflows", async (req, res) => {
    try {
      const { name, description, workflowJson, category } = req.body;
      if (!name || !workflowJson) return res.status(400).json({ error: "name and workflowJson required" });
      const wf = workflowStore.create({
        name,
        description: description || "",
        workflowJson: typeof workflowJson === "string" ? workflowJson : JSON.stringify(workflowJson),
        category: category || "custom",
      });
      res.json(wf);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/comfyui/workflows/:id
  app.delete("/api/comfyui/workflows/:id", async (req, res) => {
    workflowStore.delete(parseInt(req.params.id));
    res.json({ success: true });
  });

  // POST /api/image/generate — generate an image via ComfyUI
  app.post("/api/image/generate", async (req, res) => {
    try {
      const {
        prompt, negativePrompt, checkpoint, width, height, steps, cfg,
        sampler, scheduler, seed, batchSize, lora, workflowId,
      } = req.body;

      if (!prompt) return res.status(400).json({ error: "prompt required" });

      const ckpt = checkpoint || settingsStore.get("comfyuiDefaultCheckpoint") || "";
      if (!ckpt) return res.status(400).json({ error: "No checkpoint model specified and no default set" });

      let workflowApiJson: Record<string, any>;

      if (workflowId) {
        const wf = workflowStore.getById(workflowId);
        if (!wf) return res.status(404).json({ error: "Workflow not found" });
        workflowApiJson = JSON.parse(wf.workflowJson);
        workflowStore.incrementUsage(workflowId);
      } else {
        workflowApiJson = buildTxt2Img({
          prompt,
          negativePrompt,
          checkpoint: ckpt,
          width: width || 1024,
          height: height || 1024,
          steps: steps || 20,
          cfg: cfg ?? 7.0,
          sampler: sampler || "euler",
          scheduler: scheduler || "normal",
          seed: seed ?? -1,
          batchSize: batchSize || 1,
          lora: lora || undefined,
        });
      }

      const result = await generateAndSave(workflowApiJson);

      if (!result.success) {
        return res.status(500).json({ error: result.error || "Generation failed" });
      }

      const fs = require("fs");
      const records = result.filePaths.map((fp: string) => {
        const stat = fs.statSync(fp);
        return generatedImageStore.create({
          prompt,
          negativePrompt: negativePrompt || null,
          model: ckpt,
          workflowJson: JSON.stringify(workflowApiJson),
          seed: seed ?? null,
          width: width || 1024,
          height: height || 1024,
          steps: steps || 20,
          cfg: cfg ?? 7.0,
          sampler: sampler || "euler",
          scheduler: scheduler || "normal",
          filePath: fp,
          fileSize: stat.size,
          generationType: "txt2img",
          durationMs: result.durationMs,
          comfyuiPromptId: result.promptId,
        });
      });

      res.json({ success: true, images: records });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/images — list all generated images (supports ?type, ?favorites, ?conversationId, ?search)
  app.get("/api/images", async (req, res) => {
    const type = req.query.type as string;
    const favorites = req.query.favorites === "true";
    const conversationId = req.query.conversationId ? parseInt(req.query.conversationId as string) : undefined;
    const search = req.query.search as string;
    let images;
    if (favorites) images = generatedImageStore.getFavorites();
    else if (conversationId) images = generatedImageStore.getByConversation(conversationId);
    else if (search) images = generatedImageStore.search(search);
    else if (type) images = generatedImageStore.getByType(type);
    else images = generatedImageStore.getAll();
    res.json(images);
  });

  // GET /api/images/file — serve an image file
  app.get("/api/images/file", async (req, res) => {
    try {
      const filePath = req.query.path as string;
      if (!filePath) return res.status(400).json({ error: "path required" });
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(IMAGES_DIR)) {
        return res.status(403).json({ error: "Access denied" });
      }
      if (!fs.existsSync(resolved)) return res.status(404).json({ error: "File not found" });
      const ext = path.extname(resolved).toLowerCase();
      const mimeMap: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
      res.setHeader("Content-Type", mimeMap[ext] || "image/png");
      res.sendFile(resolved);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/images/:id — get single image record
  app.get("/api/images/:id", async (req, res) => {
    const img = generatedImageStore.getById(parseInt(req.params.id));
    if (!img) return res.status(404).json({ error: "Image not found" });
    res.json(img);
  });

  // POST /api/images/:id/favorite — toggle favorite
  app.post("/api/images/:id/favorite", async (req, res) => {
    const img = generatedImageStore.toggleFavorite(parseInt(req.params.id));
    if (!img) return res.status(404).json({ error: "Image not found" });
    res.json(img);
  });

  // POST /api/images/inpaint — direct inpaint endpoint for gallery editor
  app.post("/api/images/inpaint", async (req, res) => {
    try {
      const { sourceImagePath, maskDataUrl, prompt, checkpoint } = req.body;
      if (!sourceImagePath || !maskDataUrl || !prompt) {
        return res.status(400).json({ error: "sourceImagePath, maskDataUrl, and prompt are required" });
      }

      const host = settingsStore.get("comfyuiHost");
      if (!host) return res.status(400).json({ error: "ComfyUI not configured" });

      // Decode the mask data URL and save to a temp file
      const maskMatch = maskDataUrl.match(/^data:image\/png;base64,(.+)$/);
      if (!maskMatch) return res.status(400).json({ error: "Invalid mask data URL" });
      const maskBuffer = Buffer.from(maskMatch[1], "base64");
      const maskPath = path.join(IMAGES_DIR, `mask-${Date.now()}.png`);
      fs.mkdirSync(IMAGES_DIR, { recursive: true });
      fs.writeFileSync(maskPath, maskBuffer);

      // Import ComfyUI functions dynamically to avoid circular deps
      const { uploadImage, uploadMask, generateAndSave, listModels: listComfyModels } = await import("./lib/comfyui-client.js");
      const { inpaintTemplate } = await import("./lib/comfyui-workflows.js");

      // Resolve checkpoint with fuzzy matching (same logic as image-tools resolveCheckpoint)
      const models = await listComfyModels();
      const allCheckpoints = models.checkpoints;
      if (allCheckpoints.length === 0) {
        return res.status(400).json({ error: "No checkpoint models found in ComfyUI" });
      }

      let ckpt: string | undefined;
      if (!checkpoint) {
        ckpt = allCheckpoints[0];
      } else if (allCheckpoints.includes(checkpoint)) {
        ckpt = checkpoint;
      } else {
        // Fuzzy match: strip path & extension
        const normalize = (s: string) => s.replace(/.*\//, "").replace(/\.(safetensors|ckpt|pt|bin)$/i, "").toLowerCase();
        const reqNorm = normalize(checkpoint);
        ckpt = allCheckpoints.find(c => normalize(c) === reqNorm)
            || allCheckpoints.find(c => normalize(c).includes(reqNorm) || reqNorm.includes(normalize(c)));
        if (!ckpt) {
          const available = allCheckpoints.slice(0, 20).join(", ");
          return res.status(400).json({
            error: `Checkpoint "${checkpoint}" not found. Available (${allCheckpoints.length}): ${available}${
              allCheckpoints.length > 20 ? " ..." : ""
            }`,
          });
        }
      }

      const [imgUpload, maskUpload] = await Promise.all([
        uploadImage(sourceImagePath),
        uploadMask(maskPath),
      ]);

      const workflow = inpaintTemplate.build({
        prompt,
        checkpoint: ckpt,
        inputImage: imgUpload.name,
        maskImage: maskUpload.name,
        denoise: 0.8,
        steps: 20,
        cfg: 7,
        seed: -1,
      });

      const result = await generateAndSave(workflow);

      // Clean up temp mask
      try { fs.unlinkSync(maskPath); } catch {}

      if (!result.success) return res.status(500).json({ error: `Inpainting failed: ${result.error}` });

      // Save to DB
      const saved = [];
      for (const fp of result.filePaths) {
        try {
          const record = generatedImageStore.create({
            filePath: fp,
            prompt,
            model: ckpt,
            steps: 20,
            cfg: 7,
            seed: -1,
            generationType: "inpaint",
            durationMs: result.durationMs,
            comfyuiPromptId: result.promptId,
          });
          saved.push(record);
        } catch {}
      }

      res.json({ success: true, images: saved, filePaths: result.filePaths, durationMs: result.durationMs });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/images/:id — delete image + file
  app.delete("/api/images/:id", async (req, res) => {
    const img = generatedImageStore.getById(parseInt(req.params.id));
    if (!img) return res.status(404).json({ error: "Image not found" });
    try {
      if (fs.existsSync(img.filePath)) fs.unlinkSync(img.filePath);
      if (img.thumbnailPath && fs.existsSync(img.thumbnailPath)) fs.unlinkSync(img.thumbnailPath);
    } catch {}
    generatedImageStore.delete(img.id);
    res.json({ success: true });
  });

  // ── Self-Development ─────────────────────────────────────────────

  // GET /api/self-dev/status — current dev session info
  app.get("/api/self-dev/status", async (req, res) => {
    const info = getDevInfo();
    res.json(info);
  });

  // POST /api/self-dev/chat — self-dev specific chat endpoint
  // Uses the self-dev system prompt and routes to coding models
  app.post("/api/self-dev/chat", async (req: AuthRequest, res) => {
    const { message, images, attachments } = req.body;
    if (!message) return res.status(400).json({ error: "Message required" });
    if (typeof message === "string" && message.length > 50000) {
      return res.status(400).json({ error: "Message too long (max 50,000 characters)" });
    }

    // Build the self-dev system prompt with full context
    const info = getDevInfo();
    const archContent = info.devDir ? await readDevFile("ARCHITECTURE.md") : null;

    // Read KNOWN_ISSUES.md from the dev base directory
    let knownIssues: string | null = null;
    try {
      const kiPath = path.join(DEV_BASE, "KNOWN_ISSUES.md");
      if (fs.existsSync(kiPath)) {
        knownIssues = fs.readFileSync(kiPath, "utf-8");
      }
    } catch {}

    const devLog = info.devDir ? await readDevFile("DEV_LOG.md") : null;
    // Session summary from previous session — injected first so model knows the state
    const sessionSummary = info.devDir ? await readDevFile("SESSION_SUMMARY.md") : null;

    // Get model routing preferences
    const selfDevCodingModel = settingsStore.get("selfDevCodingModel") || undefined;

    const systemPrompt = buildSelfDevPrompt({
      devDir: info.devDir,
      stableDir: info.stableDir,
      devNumber: info.devNumber,
      architectureContent: archContent,
      knownIssuesContent: knownIssues,
      devLogContent: devLog,
      sessionSummary: sessionSummary,
      configuredModels: { coding: selfDevCodingModel },
      lastBuildResult: info.lastBuild,
      lastTestResult: info.lastTests,
    });

    // SSE setup
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const requestId = uuid();

    // Create or get self-dev conversation
    let convId: number;
    const selfDevConvIdStr = settingsStore.get("selfDevConversationId");
    if (selfDevConvIdStr) {
      convId = parseInt(selfDevConvIdStr);
      const existing = conversationStore.getById(convId);
      if (!existing) {
        const conv = conversationStore.create({ title: "Self-Development", systemPrompt });
        convId = conv.id;
        settingsStore.set("selfDevConversationId", String(convId));
      }
    } else {
      const conv = conversationStore.create({ title: "Self-Development", systemPrompt });
      convId = conv.id;
      settingsStore.set("selfDevConversationId", String(convId));
    }

    // Create AgentStream for self-dev — same pattern as main chat.
    // Self-dev tasks are long-running, so background resilience is critical.
    const agentStream = getOrCreateStream(convId, requestId);
    const streamWriter = createStreamWriter(agentStream);
    const unsubStream = agentStream.subscribe(res);

    // Broadcast wrapper (same as main chat)
    const originalStreamWrite = agentStream.write.bind(agentStream);
    agentStream.write = function(sseData: string): boolean {
      const result = originalStreamWrite(sseData);
      broadcast(convId, sseData);
      return result;
    };

    const out = streamWriter;
    out.write(`data: ${JSON.stringify({ type: "request_id", requestId })}\n\n`);

    // Clear old status events and intercept new ones into the server-side buffer
    // so any tab (including a second tab) can read the current activity feed via the status poll
    clearStatusEvents();
    const originalWrite = out.write.bind(out);
    out.write = function(sseData: string): boolean {
      try {
        const json = JSON.parse(sseData.replace(/^data: /, "").trim());
        if (json.type === "status") pushStatusEvent(json);
      } catch {}
      return originalWrite(sseData);
    };

    // Store user message
    messageStore.create({
      conversationId: convId,
      role: "user",
      content: message,
      images: images ? JSON.stringify(images) : undefined,
      attachments: attachments ? JSON.stringify(attachments) : undefined,
    });

    // Route to an appropriate model/endpoint using the same orchestrator as regular chat.
    // To control which model self-dev uses, enable/disable models in the Models settings page.
    try {
      const autoRouting = settingsStore.get("autoRouting") !== "false";
      const routing = await routeMessage(message, autoRouting, convId);

      // Self-dev skips planTask — the self-dev system prompt already provides full guidance,
      // and firing a separate planning call would create a second concurrent request to the
      // same model endpoint, causing context bleed on single-model setups.

      if (!routing) {
        out.write(`data: ${JSON.stringify({ type: "error", content: "No model available" })}\n\n`);
        out.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
        agentStream.end();
        return;
      }

      // Build messages array from conversation history
      const historyMsgs = messageStore.getByConversation(convId);
      const chatMessages = historyMsgs.map((m) => {
        const messageContent = m.content || "";
        if (m.images) {
          try {
            const imgs = JSON.parse(m.images) as Array<{ name: string; base64: string; mimeType: string }>;
            if (imgs.length > 0) {
              if (!routing.model.supportsVision) {
                console.warn(`[SelfDev] Stripping ${imgs.length} image(s) — model ${routing.model.modelId} does not support vision`);
                return { role: m.role as any, content: messageContent };
              }
              const content: any[] = [{ type: "text", text: messageContent }];
              for (const img of imgs) {
                content.push({ type: "image_url", image_url: { url: img.base64 } });
              }
              return { role: m.role as any, content };
            }
          } catch {}
        }
        return { role: m.role as any, content: messageContent };
      });

      markActive(convId);
      try {
        // Pass StreamWriter instead of res — self-dev loop survives browser disconnects
        await runAgentLoop({
          conversationId: convId,
          messages: chatMessages,
          model: routing.model,
          endpoint: routing.endpoint,
          taskType: routing.taskType,
          res: out,
          requestId,
          systemPrompt,
        });
      } finally {
        markInactive(convId);
      }
    } catch (err: any) {
      console.error("[SelfDev] Error:", err);
      try {
        out.write(`data: ${JSON.stringify({ type: "error", content: err.message })}\n\n`);
        out.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
      } catch { /* stream ended */ }
    }

    try { agentStream.end(); } catch { /* already ended */ }
  });

  // GET /api/self-dev/conversation — get self-dev conversation messages
  app.get("/api/self-dev/conversation", async (req, res) => {
    const convIdStr = settingsStore.get("selfDevConversationId");
    if (!convIdStr) return res.json({ messages: [], conversationId: null });

    const convId = parseInt(convIdStr);
    const msgs = messageStore.getByConversation(convId);
    res.json({ messages: msgs, conversationId: convId });
  });

  // POST /api/self-dev/new-session — start fresh self-dev conversation
  app.post("/api/self-dev/new-session", async (req, res) => {
    const conv = conversationStore.create({ title: "Self-Development" });
    settingsStore.set("selfDevConversationId", String(conv.id));
    res.json({ conversationId: conv.id });
  });

  // POST /api/self-dev/inject — inject a mid-task message into the running agent loop
  // Allows the user to send corrections/nudges without interrupting the session.
  app.post("/api/self-dev/inject", async (req: AuthRequest, res) => {
    const { message } = req.body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "message required" });
    }

    const selfDevConvIdStr = settingsStore.get("selfDevConversationId");
    if (!selfDevConvIdStr) {
      return res.status(404).json({ error: "No active self-dev conversation" });
    }
    const convId = parseInt(selfDevConvIdStr);

    const stream = getStream(convId);
    if (!stream || stream.done) {
      return res.status(404).json({ error: "No active agent loop running — send a regular message instead" });
    }

    stream.injectUserMessage(message);
    console.log(`[SelfDev] Mid-task message injected: "${message.slice(0, 80)}"`);
    return res.json({ ok: true, message: "Message queued for injection at next iteration" });
  });

  // GET /api/self-dev/screenshots — list screenshots
  app.get("/api/self-dev/screenshots", async (req, res) => {
    try {
      if (!fs.existsSync(SCREENSHOTS_DIR)) return res.json([]);
      const files = fs.readdirSync(SCREENSHOTS_DIR)
        .filter((f: string) => f.endsWith(".png"))
        .map((f: string) => ({
          name: f,
          path: path.join(SCREENSHOTS_DIR, f),
          size: fs.statSync(path.join(SCREENSHOTS_DIR, f)).size,
          created: fs.statSync(path.join(SCREENSHOTS_DIR, f)).mtime.toISOString(),
        }));
      res.json(files);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/self-dev/init — initialize dev session
  app.post("/api/self-dev/init", async (req, res) => {
    try {
      const result = initDevSession();
      res.json({ success: true, message: `Dev session ${result.devNumber} initialized`, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/self-dev/build — build the dev workspace
  app.post("/api/self-dev/build", async (req, res) => {
    try {
      const result = buildDev();
      res.json({ success: result.success, message: result.success ? "Build succeeded" : "Build failed", output: result.output });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/self-dev/start-server — start dev server on port 5050
  app.post("/api/self-dev/start-server", async (req, res) => {
    try {
      const result = startDevServer();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/self-dev/stop-server — stop dev server
  app.post("/api/self-dev/stop-server", async (req, res) => {
    try {
      const result = stopDevServer();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/self-dev/run-tests — run test suite against dev server
  app.post("/api/self-dev/run-tests", async (req, res) => {
    try {
      const results = await runAllTests();
      const summary = getTestSummary(results.results);
      res.json({
        success: results.failed === 0,
        message: `${results.passed}/${results.total} passed`,
        passed: results.passed,
        failed: results.failed,
        total: results.total,
        summary,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/self-dev/files — list files in dev workspace directory
  app.get("/api/self-dev/files", async (req, res) => {
    try {
      const dirPath = (req.query.path as string) || ".";
      const files = listDevFiles(dirPath);
      // Parse the emoji-prefixed format into structured data
      const structured = files.map(f => {
        const isDir = f.startsWith("\uD83D\uDCC1"); // 📁
        const name = f.replace(/^[\uD83D\uDCC1\uD83D\uDCC4]\s*/, ""); // Remove emoji prefix
        return { name, type: isDir ? "directory" : "file" };
      });
      res.json(structured);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/self-dev/file — read a single file from dev workspace
  app.get("/api/self-dev/file", async (req, res) => {
    try {
      const filePath = req.query.path as string;
      if (!filePath) return res.status(400).json({ error: "path required" });
      const content = await readDevFile(filePath);
      if (content === null) return res.status(404).json({ error: "File not found" });
      res.json({ content, path: filePath });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/self-dev/diff?path=<filePath> — diff a dev file vs stable (for reset preview UI)
  app.get("/api/self-dev/diff", (req, res) => {
    try {
      const filePath = req.query.path as string;
      if (!filePath) return res.status(400).json({ error: "path required" });
      const result = diffFile(filePath);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Promote & Rollback ──────────────────────────────────────────────────────────────────

  // GET /api/self-dev/releases — list all production snapshots
  app.get("/api/self-dev/releases", (_req, res) => {
    try {
      res.json(listReleases());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/self-dev/promote — promote current dev session to production
  // Body: { devNumber: number, includeData: boolean, includeSettings: boolean }
  // Streams SSE events: { type, message, releaseId? }
  app.post("/api/self-dev/promote", async (req, res) => {
    const { devNumber, includeData = false, includeSettings = false } = req.body;
    if (typeof devNumber !== "number") {
      return res.status(400).json({ error: "devNumber (number) required" });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const send = (event: object) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      for await (const event of promoteDevToProduction({ devNumber, includeData, includeSettings })) {
        send(event);
        if (event.type === "success" || event.type === "error") break;
      }
    } catch (err: any) {
      send({ type: "error", message: err.message });
    } finally {
      res.end();
    }
  });

  // POST /api/self-dev/rollback — roll back production to a prior release
  // Body: { releaseId: string }
  app.post("/api/self-dev/rollback", async (req, res) => {
    const { releaseId } = req.body;
    if (!releaseId) return res.status(400).json({ error: "releaseId required" });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const send = (event: object) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      for await (const event of rollbackToRelease(releaseId)) {
        send(event);
        if (event.type === "success" || event.type === "error") break;
      }
    } catch (err: any) {
      send({ type: "error", message: err.message });
    } finally {
      res.end();
    }
  });

  // DELETE /api/self-dev/releases/:id — delete a snapshot to free disk space
  app.delete("/api/self-dev/releases/:id", (req, res) => {
    try {
      const result = deleteRelease(req.params.id);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}


// ── File tree builder ───────────────────────────────────────────────────────────────────
interface FileNode {
  name: string;
  path: string; // relative to project root
  type: "file" | "directory";
  children?: FileNode[];
  size?: number;
}

const FILE_TREE_SKIP = new Set(["node_modules", ".git", "__pycache__", ".venv", "venv", ".next", "dist", "build", ".cache"]);

function buildFileTree(rootPath: string, relativePath: string = ""): FileNode[] {
  const fullPath = path.join(rootPath, relativePath);
  if (!fs.existsSync(fullPath)) return [];

  const entries = fs.readdirSync(fullPath, { withFileTypes: true });
  const nodes: FileNode[] = [];

  for (const entry of entries.sort((a, b) => {
    // Directories first, then alphabetical
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  })) {
    if (FILE_TREE_SKIP.has(entry.name)) continue;

    const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: relPath,
        type: "directory",
        children: buildFileTree(rootPath, relPath),
      });
    } else {
      const stat = fs.statSync(path.join(fullPath, entry.name));
      nodes.push({
        name: entry.name,
        path: relPath,
        type: "file",
        size: stat.size,
      });
    }
  }

  return nodes;
}

// ── Background benchmark runner ───────────────────────────────────
async function runBenchmark(runId: number, suite: any, model: any, endpoint: any) {
  const prompts = JSON.parse(suite.prompts);
  const results: any[] = [];
  let totalTokens = 0;
  let totalDuration = 0;

  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i];
    const startTime = Date.now();

    try {
      const response = await chatCompletion(endpoint, model, [
        { role: "user", content: prompt.prompt },
      ], { temperature: 0.7 });

      const duration = Date.now() - startTime;
      totalTokens += (response.tokensIn + response.tokensOut);
      totalDuration += duration;

      results.push({
        promptIndex: i,
        prompt: prompt.prompt,
        category: prompt.category,
        response: response.content,
        tokensIn: response.tokensIn,
        tokensOut: response.tokensOut,
        durationMs: duration,
        rating: null, // User rates later
      });
    } catch (err: any) {
      results.push({
        promptIndex: i,
        prompt: prompt.prompt,
        category: prompt.category,
        response: null,
        error: err.message,
        durationMs: Date.now() - startTime,
        rating: null,
      });
    }
  }

  benchmarkStore.updateRun(runId, {
    status: "completed",
    results: JSON.stringify(results),
    totalTokens,
    totalDurationMs: totalDuration,
    completedAt: new Date().toISOString(),
  });
}
