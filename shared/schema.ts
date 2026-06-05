import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ── Authentication ──────────────────────────────────────────────────
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// ── API Endpoints (LM Studio instances + cloud providers) ──────────
export const endpoints = sqliteTable("endpoints", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  url: text("url").notNull(),
  // v16.73.3: canonical values are `lmstudio | openrouter | openai_compatible`.
  // Legacy provider rows are treated at runtime as `openai_compatible`
  // where possible (see `normalizeProviderType()` in server/lib/llm-client.ts).
  providerType: text("provider_type").notNull().default("lmstudio"),
  apiKey: text("api_key"), // Bearer token for cloud / OpenAI-compatible endpoints
  isOrchestrator: integer("is_orchestrator", { mode: "boolean" }).notNull().default(false),
  parallelSlots: integer("parallel_slots").notNull().default(1), // Default 1 — safe for large 100-200B models; increase in Settings for smaller models
  isEnabled: integer("is_enabled", { mode: "boolean" }).notNull().default(true),
  lastSeen: text("last_seen"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// ── Models (synced from LM Studio) ──────────────────────────────────
export const models = sqliteTable("models", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  endpointId: integer("endpoint_id").notNull().references(() => endpoints.id),
  modelId: text("model_id").notNull(),
  type: text("type").notNull().default("llm"),
  paramsString: text("params_string"),
  quantization: text("quantization"),
  maxContextLength: integer("max_context_length"),    // Model's max supported context (from LM Studio v0 API)
  loadedContextLength: integer("loaded_context_length"), // Actual loaded context (may be lower than max)
  preferredContextLength: integer("preferred_context_length"), // User-set: load with this context length via LM Studio load API
  isEnabled: integer("is_enabled", { mode: "boolean" }).notNull().default(false),
  isSubAgent: integer("is_sub_agent", { mode: "boolean" }).notNull().default(false), // When true, used exclusively for sub-agent tasks
  taskAssignment: text("task_assignment"), // JSON array of tags: ["coding","research"] — or legacy single string
  supportsToolCalling: integer("supports_tool_calling", { mode: "boolean" }).notNull().default(false),
  supportsVision: integer("supports_vision", { mode: "boolean" }).notNull().default(false),
  temperature: real("temperature"),  // Per-model temperature override (null = use smart default)
  topP: real("top_p"),               // Per-model top_p override (null = use smart default)
  thinkingEnabled: integer("thinking_enabled", { mode: "boolean" }).notNull().default(false),
  // v16.74.5: per-model reasoning/thinking profiles. JSON array of ReasoningProfile
  // (see below). Lets each model carry its own set of thinking modes — selectable
  // per-message via the chat lightbulb selector. Null/empty = no custom modes
  // (legacy thinkingEnabled still honoured as an implicit "default high" profile).
  reasoningProfiles: text("reasoning_profiles"),
  notes: text("notes"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// ── Chat Groups (conversation folders) ─────────────────────────────
export const chatGroups = sqliteTable("chat_groups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  color: text("color"), // optional accent color hex
  orderIndex: integer("order_index").notNull().default(0),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// ── Conversations ───────────────────────────────────────────────────
export const conversations = sqliteTable("conversations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull().default("New Chat"),
  systemPrompt: text("system_prompt"),
  isArchived: integer("is_archived", { mode: "boolean" }).notNull().default(false),
  groupId: integer("group_id").references(() => chatGroups.id),
  parentSessionId: integer("parent_session_id"), // links compressed sessions back to their parent
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// ── Messages ────────────────────────────────────────────────────────
export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conversationId: integer("conversation_id").notNull().references(() => conversations.id),
  role: text("role").notNull(), // user | assistant | system | tool
  content: text("content").notNull(),
  modelId: text("model_id"),
  endpointId: integer("endpoint_id"),
  toolCalls: text("tool_calls"), // JSON array of tool calls made
  toolResults: text("tool_results"), // JSON array of tool results
  tokenCount: integer("token_count"),
  durationMs: integer("duration_ms"),
  taskType: text("task_type"),
  confidence: text("confidence"), // "green" | "yellow" | "red" — set after agent loop completes
  images: text("images"), // JSON array of { name, base64, mimeType } for image attachments
  attachments: text("attachments"), // JSON array of { name, content, mimeType } for file attachments
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// ── Task Plans ──────────────────────────────────────────────────────
export const taskPlans = sqliteTable("task_plans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conversationId: integer("conversation_id").notNull().references(() => conversations.id),
  messageId: integer("message_id").references(() => messages.id),
  originalRequest: text("original_request").notNull(),
  planJson: text("plan_json").notNull(), // JSON DAG of subtasks
  status: text("status").notNull().default("pending"), // pending | running | completed | failed
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  completedAt: text("completed_at"),
});

// ── Subtasks ────────────────────────────────────────────────────────
export const subtasks = sqliteTable("subtasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  planId: integer("plan_id").notNull().references(() => taskPlans.id),
  parentId: integer("parent_id"), // self-reference for DAG
  title: text("title").notNull(),
  description: text("description").notNull(),
  taskType: text("task_type").notNull(), // coding | research | creative | math | general
  status: text("status").notNull().default("pending"), // pending | running | completed | failed | skipped
  result: text("result"), // output text or JSON
  modelUsed: text("model_used"),
  endpointUsed: integer("endpoint_used"),
  toolsUsed: text("tools_used"), // JSON array
  durationMs: integer("duration_ms"),
  orderIndex: integer("order_index").notNull().default(0),
  dependsOn: text("depends_on"), // JSON array of subtask IDs this depends on
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  completedAt: text("completed_at"),
});

// ── Skills Library ──────────────────────────────────────────────────
export const skills = sqliteTable("skills", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  description: text("description").notNull(),
  category: text("category").notNull().default("general"),
  triggerPatterns: text("trigger_patterns"), // JSON array of patterns that activate this skill
  systemPrompt: text("system_prompt"), // injected into context when skill is active
  toolsRequired: text("tools_required"), // JSON array of tool names this skill needs
  instructions: text("instructions").notNull(), // step-by-step procedure
  version: integer("version").notNull().default(1),
  isEnabled: integer("is_enabled", { mode: "boolean" }).notNull().default(true),
  usageCount: integer("usage_count").notNull().default(0),
  lastUsedAt: text("last_used_at"),
  createdBy: text("created_by").notNull().default("user"), // user | agent
  approvalStatus: text("approval_status").notNull().default("approved"), // approved | pending | rejected
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const skillVersions = sqliteTable("skill_versions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  skillId: integer("skill_id").notNull().references(() => skills.id),
  version: integer("version").notNull(),
  instructions: text("instructions").notNull(),
  systemPrompt: text("system_prompt"),
  changeReason: text("change_reason"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// ── Docker Apps (App Store) ─────────────────────────────────────────
export const apps = sqliteTable("apps", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description").notNull(),
  category: text("category").notNull().default("tool"), // tool | game | web | utility | media
  containerId: text("container_id"), // Docker container ID when running
  imageName: text("image_name").notNull(), // Docker image name
  port: integer("port"), // Host port mapped to container
  internalPort: integer("internal_port").notNull().default(8080), // Container internal port
  status: text("status").notNull().default("stopped"), // building | running | stopped | error
  buildPath: text("build_path"), // path to Dockerfile/source on host
  dockerfile: text("dockerfile"), // Dockerfile contents
  envVars: text("env_vars"), // JSON object of environment variables
  volumeMounts: text("volume_mounts"), // JSON array of volume mounts
  iconEmoji: text("icon_emoji").default("📦"),
  version: integer("version").notNull().default(1), // Current version number
  lastStarted: text("last_started"),
  lastStopped: text("last_stopped"),
  errorLog: text("error_log"),
  createdByConversation: integer("created_by_conversation"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// ── Benchmarks ──────────────────────────────────────────────────────
export const benchmarkSuites = sqliteTable("benchmark_suites", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),
  prompts: text("prompts").notNull(), // JSON array of {prompt, category, expectedBehavior?}
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const benchmarkRuns = sqliteTable("benchmark_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  suiteId: integer("suite_id").notNull().references(() => benchmarkSuites.id),
  modelId: text("model_id").notNull(),
  endpointId: integer("endpoint_id").notNull(),
  status: text("status").notNull().default("pending"), // pending | running | completed | failed
  results: text("results"), // JSON array of {promptIndex, response, tokenCount, durationMs, rating?}
  averageRating: real("average_rating"),
  totalTokens: integer("total_tokens"),
  totalDurationMs: integer("total_duration_ms"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  completedAt: text("completed_at"),
});

// ── Analytics ───────────────────────────────────────────────────────
export const analyticsEvents = sqliteTable("analytics_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventType: text("event_type").notNull(), // chat | tool_call | code_exec | app_deploy | skill_use | benchmark
  modelId: text("model_id"),
  endpointId: integer("endpoint_id"),
  taskType: text("task_type"),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  durationMs: integer("duration_ms"),
  success: integer("success", { mode: "boolean" }).notNull().default(true),
  metadata: text("metadata"), // JSON for event-specific data
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// ── Memory (cross-session recall) ───────────────────────────────────
export const memoryEntries = sqliteTable("memory_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  category: text("category").notNull(), // fact | preference | project | context
  content: text("content").notNull(),
  importance: integer("importance").notNull().default(5), // 1-10
  conversationId: integer("conversation_id"),
  // v16.40: memory scoping — 'general' or 'project:{projectId}'
  // General memories are visible in all contexts; project memories only within that project.
  scope: text("scope").notNull().default("general"),
  expiresAt: text("expires_at"), // null = permanent
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// ── Settings ────────────────────────────────────────────────────────
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// ── Projects (Coding Workspace) ────────────────────────────────────
export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),
  path: text("path").notNull(), // Absolute path on host filesystem (e.g. /home/user/projects/my-app)
  language: text("language"), // Primary language (auto-detected or user-set)
  conversationId: integer("conversation_id").references(() => conversations.id), // Dedicated project chat
  status: text("status").notNull().default("active"), // active | archived
  lastOpenedFile: text("last_opened_file"), // Remember last file user was editing
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// ── MCP Servers ────────────────────────────────────────────────────
export const mcpServers = sqliteTable("mcp_servers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  command: text("command").notNull(), // e.g. "npx -y @modelcontextprotocol/server-filesystem /home/user"
  args: text("args"), // JSON array of additional args
  envVars: text("env_vars"), // JSON object of env vars
  transportType: text("transport_type").notNull().default("stdio"), // "stdio" | "sse"
  sseUrl: text("sse_url"), // for SSE transport
  isEnabled: integer("is_enabled", { mode: "boolean" }).notNull().default(true),
  status: text("status").notNull().default("disconnected"), // "connected" | "disconnected" | "error"
  lastError: text("last_error"),
  toolCount: integer("tool_count").notNull().default(0),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// ── Background Tasks ────────────────────────────────────────────────
export const backgroundTasks = sqliteTable("background_tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull().default("queued"), // "queued" | "running" | "completed" | "failed" | "cancelled"
  type: text("type").notNull().default("one-shot"), // "one-shot" | "scheduled"
  cronExpression: text("cron_expression"), // e.g. "0 * * * *" for scheduled
  result: text("result"),
  progress: integer("progress").notNull().default(0), // 0-100
  logs: text("logs"), // JSON array of log entries
  conversationId: integer("conversation_id"),
  modelId: text("model_id"),
  endpointId: integer("endpoint_id"),
  error: text("error"),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  nextRunAt: text("next_run_at"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// ── Generated Images ────────────────────────────────────────────────
export const generatedImages = sqliteTable("generated_images", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  prompt: text("prompt").notNull(),
  negativePrompt: text("negative_prompt"),
  model: text("model"), // checkpoint name used
  workflowId: integer("workflow_id"), // references comfyuiWorkflows if used
  workflowJson: text("workflow_json"), // full API JSON used for this generation
  seed: integer("seed"),
  width: integer("width"),
  height: integer("height"),
  steps: integer("steps"),
  cfg: real("cfg"),
  sampler: text("sampler"),
  scheduler: text("scheduler"),
  denoise: real("denoise"),
  filePath: text("file_path").notNull(), // absolute path to image file
  thumbnailPath: text("thumbnail_path"), // smaller version for gallery
  fileSize: integer("file_size"),
  mimeType: text("mime_type").notNull().default("image/png"),
  generationType: text("generation_type").notNull().default("txt2img"), // txt2img | img2img | inpaint | upscale | controlnet | bg_removal | face_restore | style_transfer
  sourceImageId: integer("source_image_id"), // self-reference for img2img/upscale chains
  conversationId: integer("conversation_id"), // which chat triggered this
  projectId: integer("project_id"), // which project this belongs to
  durationMs: integer("duration_ms"),
  comfyuiPromptId: text("comfyui_prompt_id"), // ComfyUI's prompt_id for tracking
  tags: text("tags"), // JSON array of user tags
  isFavorite: integer("is_favorite", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// ── ComfyUI Workflows ───────────────────────────────────────────────
export const comfyuiWorkflows = sqliteTable("comfyui_workflows", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),
  workflowJson: text("workflow_json").notNull(), // API format JSON
  category: text("category").notNull().default("custom"), // txt2img | img2img | upscale | inpaint | controlnet | bg_removal | face_restore | style_transfer | custom
  isBuiltIn: integer("is_built_in", { mode: "boolean" }).notNull().default(false),
  parameters: text("parameters"), // JSON describing which fields are configurable
  thumbnailPath: text("thumbnail_path"), // preview image
  usageCount: integer("usage_count").notNull().default(0),
  lastUsedAt: text("last_used_at"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// ── Insert schemas ──────────────────────────────────────────────────
export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true, updatedAt: true });
export const insertEndpointSchema = createInsertSchema(endpoints).omit({ id: true, createdAt: true });
export const insertModelSchema = createInsertSchema(models).omit({ id: true, createdAt: true });
export const insertConversationSchema = createInsertSchema(conversations).omit({ id: true, createdAt: true, updatedAt: true });
export const insertMessageSchema = createInsertSchema(messages).omit({ id: true, createdAt: true });
export const insertTaskPlanSchema = createInsertSchema(taskPlans).omit({ id: true, createdAt: true });
export const insertSubtaskSchema = createInsertSchema(subtasks).omit({ id: true, createdAt: true });
export const insertSkillSchema = createInsertSchema(skills).omit({ id: true, createdAt: true, updatedAt: true, usageCount: true });
export const insertAppSchema = createInsertSchema(apps).omit({ id: true, createdAt: true, updatedAt: true });
export const insertBenchmarkSuiteSchema = createInsertSchema(benchmarkSuites).omit({ id: true, createdAt: true });
export const insertBenchmarkRunSchema = createInsertSchema(benchmarkRuns).omit({ id: true, createdAt: true });
export const insertAnalyticsEventSchema = createInsertSchema(analyticsEvents).omit({ id: true, createdAt: true });
export const insertMemoryEntrySchema = createInsertSchema(memoryEntries).omit({ id: true, createdAt: true, updatedAt: true });
export const insertChatGroupSchema = createInsertSchema(chatGroups).omit({ id: true, createdAt: true });
export const insertProjectSchema = createInsertSchema(projects).omit({ id: true, createdAt: true, updatedAt: true });
export const insertMcpServerSchema = createInsertSchema(mcpServers).omit({ id: true, createdAt: true });
export const insertBackgroundTaskSchema = createInsertSchema(backgroundTasks).omit({ id: true, createdAt: true });
export const insertGeneratedImageSchema = createInsertSchema(generatedImages).omit({ id: true, createdAt: true });
export const insertComfyuiWorkflowSchema = createInsertSchema(comfyuiWorkflows).omit({ id: true, createdAt: true, updatedAt: true });

// ── Types ───────────────────────────────────────────────────────────
export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type Endpoint = typeof endpoints.$inferSelect;
export type InsertEndpoint = z.infer<typeof insertEndpointSchema>;
export type Model = typeof models.$inferSelect;
export type InsertModel = z.infer<typeof insertModelSchema>;
export type Conversation = typeof conversations.$inferSelect;
export type InsertConversation = z.infer<typeof insertConversationSchema>;
export type Message = typeof messages.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type TaskPlan = typeof taskPlans.$inferSelect;
export type InsertTaskPlan = z.infer<typeof insertTaskPlanSchema>;
export type Subtask = typeof subtasks.$inferSelect;
export type InsertSubtask = z.infer<typeof insertSubtaskSchema>;
export type Skill = typeof skills.$inferSelect;
export type InsertSkill = z.infer<typeof insertSkillSchema>;
export type App = typeof apps.$inferSelect;
export type InsertApp = z.infer<typeof insertAppSchema>;
export type BenchmarkSuite = typeof benchmarkSuites.$inferSelect;
export type InsertBenchmarkSuite = z.infer<typeof insertBenchmarkSuiteSchema>;
export type BenchmarkRun = typeof benchmarkRuns.$inferSelect;
export type InsertBenchmarkRun = z.infer<typeof insertBenchmarkRunSchema>;
export type AnalyticsEvent = typeof analyticsEvents.$inferSelect;
export type InsertAnalyticsEvent = z.infer<typeof insertAnalyticsEventSchema>;
export type MemoryEntry = typeof memoryEntries.$inferSelect;
export type InsertMemoryEntry = z.infer<typeof insertMemoryEntrySchema>;
export type ChatGroup = typeof chatGroups.$inferSelect;
export type InsertChatGroup = z.infer<typeof insertChatGroupSchema>;
export type Project = typeof projects.$inferSelect;
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type McpServer = typeof mcpServers.$inferSelect;
export type InsertMcpServer = z.infer<typeof insertMcpServerSchema>;
export type BackgroundTask = typeof backgroundTasks.$inferSelect;
export type InsertBackgroundTask = z.infer<typeof insertBackgroundTaskSchema>;
export type GeneratedImage = typeof generatedImages.$inferSelect;
export type InsertGeneratedImage = z.infer<typeof insertGeneratedImageSchema>;
export type ComfyuiWorkflow = typeof comfyuiWorkflows.$inferSelect;
export type InsertComfyuiWorkflow = z.infer<typeof insertComfyuiWorkflowSchema>;

export type GenerationType = "txt2img" | "img2img" | "inpaint" | "upscale" | "controlnet" | "bg_removal" | "face_restore" | "style_transfer";
export type TaskType = "coding" | "research" | "creative" | "math" | "general";
export type AppStatus = "building" | "running" | "stopped" | "error";
export type SubtaskStatus = "pending" | "running" | "completed" | "failed" | "skipped";

// ── Reasoning / Thinking Profiles (v16.74.5) ────────────────────────
// Per-model, user-defined "thinking modes". Stored as a JSON array in
// models.reasoningProfiles. The chat lightbulb selector lists the configured
// profiles for the active model; the chosen profile shapes the LLM request.
//
// `strategy` controls HOW the request body is shaped (see server/lib/llm-client.ts
// applyReasoning). It is intentionally provider-agnostic so the same profile can
// be reused across endpoints — strategies that don't apply to the current provider
// are no-ops rather than errors.
export type ReasoningStrategy =
  | "off"                    // explicitly disable thinking (where the provider supports disabling)
  | "auto"                   // let the provider/model decide — send nothing extra
  | "openai_effort"          // OpenAI / OpenRouter: reasoning_effort | reasoning.effort
  | "anthropic_budget"       // Anthropic-style: thinking { type: 'enabled', budget_tokens }
  | "gemini_budget"          // Gemini: thinkingConfig.thinkingBudget (best-effort on current path)
  | "openrouter_extra_body"  // OpenRouter: merge into reasoning {} (effort/max_tokens/exclude)
  | "prompt_prefix"          // inject an instruction prefix into the user/system prompt
  | "custom_json";           // merge an allowlisted/top-level JSON blob into the request body

export type ReasoningLevel = "low" | "medium" | "high";

export interface ReasoningProfile {
  id: string;                 // stable unique id within the model (e.g. crypto/random)
  label: string;              // display name shown in the selector ("OpenAI High", "Budget 8k")
  strategy: ReasoningStrategy;
  level?: ReasoningLevel;     // for openai_effort
  budgetTokens?: number;      // for anthropic_budget / gemini_budget
  promptPrefix?: string;      // for prompt_prefix
  customBody?: Record<string, any>; // for custom_json / openrouter_extra_body
  isDefault?: boolean;        // selected by default in the lightbulb when none chosen
}

// Zod validator — used by the model PATCH route to reject malformed profiles
// before they reach the DB. Kept permissive on optional fields so presets and
// hand-edited JSON both validate.
export const reasoningProfileSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(80),
  strategy: z.enum([
    "off", "auto", "openai_effort", "anthropic_budget",
    "gemini_budget", "openrouter_extra_body", "prompt_prefix", "custom_json",
  ]),
  level: z.enum(["low", "medium", "high"]).optional(),
  budgetTokens: z.number().int().positive().max(200000).optional(),
  promptPrefix: z.string().max(4000).optional(),
  customBody: z.record(z.any()).optional(),
  isDefault: z.boolean().optional(),
});

export const reasoningProfilesSchema = z.array(reasoningProfileSchema).max(20);

/** Parse the stored JSON column into a typed array, tolerating null/garbage. */
export function parseReasoningProfiles(raw?: string | null): ReasoningProfile[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const result = reasoningProfilesSchema.safeParse(parsed);
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}

/**
 * Resolve which profile to apply for a request.
 * - If a profileId is given and matches a configured profile, use it.
 * - Else fall back to the model's default profile (isDefault) if any.
 * - Else, for backwards-compat, if the legacy thinkingEnabled flag is on and no
 *   profiles are configured, synthesize an implicit "high effort" profile.
 * - Else null (no reasoning shaping).
 */
export function resolveReasoningProfile(
  model: { reasoningProfiles?: string | null; thinkingEnabled?: boolean | null },
  profileId?: string | null,
  profileLabel?: string | null,
): ReasoningProfile | null {
  const profiles = parseReasoningProfiles(model.reasoningProfiles);
  if (profileId || profileLabel) {
    if (profileId === "__off__") return { id: "__off__", label: "Off", strategy: "off" };
    // Match by id first; fall back to label. Under auto-routing the chosen id
    // belongs to whichever model the chat UI deduped against — a different
    // routed model may carry the same mode under a different id but same label.
    const found = profiles.find(p => p.id === profileId)
      ?? (profileLabel ? profiles.find(p => p.label === profileLabel) : undefined);
    if (found) return found;
  }
  const def = profiles.find(p => p.isDefault);
  if (def) return def;
  if (profiles.length === 0 && model.thinkingEnabled) {
    return { id: "__legacy__", label: "Thinking", strategy: "openai_effort", level: "high" };
  }
  return null;
}
