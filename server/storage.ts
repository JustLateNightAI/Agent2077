import { db, sqlite } from "./db.js";
import { eq, desc, and, like, sql, inArray, gt } from "drizzle-orm";
import * as s from "../shared/schema.js";
import bcrypt from "bcryptjs";

// ── Users ───────────────────────────────────────────────────────────
export const userStore = {
  getById(id: number): s.User | undefined {
    return db.select().from(s.users).where(eq(s.users.id, id)).get();
  },
  getByUsername(username: string): s.User | undefined {
    return db.select().from(s.users).where(eq(s.users.username, username)).get();
  },
  create(data: s.InsertUser): s.User {
    const passwordHash = bcrypt.hashSync(data.passwordHash, 12);
    return db.insert(s.users).values({ ...data, passwordHash }).returning().get();
  },
  updatePassword(id: number, newPassword: string) {
    const passwordHash = bcrypt.hashSync(newPassword, 12);
    return db.update(s.users).set({ passwordHash, updatedAt: new Date().toISOString() }).where(eq(s.users.id, id)).run();
  },
  updateUsername(id: number, username: string) {
    return db.update(s.users).set({ username, updatedAt: new Date().toISOString() }).where(eq(s.users.id, id)).run();
  },
  verifyPassword(user: s.User, password: string): boolean {
    return bcrypt.compareSync(password, user.passwordHash);
  },
  ensureDefaultUser() {
    const existing = this.getByUsername("Agent2077");
    if (!existing) {
      this.create({ username: "Agent2077", passwordHash: "Agent2077" });
      console.log("[Auth] Default user created: Agent2077 / Agent2077");
    }
  },
};

// ── Endpoints ───────────────────────────────────────────────────────
function normalizeEndpointProviderType<T extends { providerType?: string | null }>(endpoint: T): T {
  if (endpoint.providerType && !["lmstudio", "openrouter", "openai_compatible"].includes(endpoint.providerType)) {
    return { ...endpoint, providerType: "openai_compatible" };
  }
  return endpoint;
}

function normalizeEndpointInput<T extends { providerType?: string | null }>(data: T): T {
  if (data.providerType && !["lmstudio", "openrouter", "openai_compatible"].includes(data.providerType)) {
    return { ...data, providerType: "openai_compatible" };
  }
  return data;
}

export const endpointStore = {
  getAll(): s.Endpoint[] {
    return db.select().from(s.endpoints).all().map(normalizeEndpointProviderType);
  },
  getById(id: number): s.Endpoint | undefined {
    const endpoint = db.select().from(s.endpoints).where(eq(s.endpoints.id, id)).get();
    return endpoint ? normalizeEndpointProviderType(endpoint) : undefined;
  },
  getOrchestrator(): s.Endpoint | undefined {
    const endpoint = db.select().from(s.endpoints).where(eq(s.endpoints.isOrchestrator, true)).get();
    return endpoint ? normalizeEndpointProviderType(endpoint) : undefined;
  },
  create(data: s.InsertEndpoint): s.Endpoint {
    return normalizeEndpointProviderType(db.insert(s.endpoints).values(normalizeEndpointInput(data)).returning().get());
  },
  update(id: number, data: Partial<s.InsertEndpoint>): s.Endpoint | undefined {
    const endpoint = db.update(s.endpoints).set(normalizeEndpointInput(data)).where(eq(s.endpoints.id, id)).returning().get();
    return endpoint ? normalizeEndpointProviderType(endpoint) : undefined;
  },
  delete(id: number) {
    return db.delete(s.endpoints).where(eq(s.endpoints.id, id)).run();
  },
};

// ── Models ──────────────────────────────────────────────────────────
export const modelStore = {
  getAll(): s.Model[] {
    return db.select().from(s.models).all();
  },
  getByEndpoint(endpointId: number): s.Model[] {
    return db.select().from(s.models).where(eq(s.models.endpointId, endpointId)).all();
  },
  getEnabled(): s.Model[] {
    return db.select().from(s.models).where(eq(s.models.isEnabled, true)).all();
  },
  getByTaskAssignment(taskType: string): s.Model[] {
    // Supports both legacy single-string and JSON array tags
    return db.select().from(s.models).where(eq(s.models.isEnabled, true)).all()
      .filter(m => {
        if (!m.taskAssignment) return false;
        const raw = m.taskAssignment.trim();
        if (raw.startsWith("[")) {
          try { return (JSON.parse(raw) as string[]).includes(taskType); } catch { return raw === taskType; }
        }
        return raw === taskType;
      });
  },
  create(data: s.InsertModel): s.Model {
    return db.insert(s.models).values(data).returning().get();
  },
  update(id: number, data: Partial<s.InsertModel>): s.Model | undefined {
    if ("taskAssignment" in data) {
      const val = data.taskAssignment;
      if (val === "" || val === "__none__" || val === "[]" || val === "none") {
        data.taskAssignment = null;
      }
    }
    return db.update(s.models).set(data).where(eq(s.models.id, id)).returning().get();
  },
  delete(id: number) {
    return db.delete(s.models).where(eq(s.models.id, id)).run();
  },
  deleteByEndpoint(endpointId: number) {
    return db.delete(s.models).where(eq(s.models.endpointId, endpointId)).run();
  },
};

// ── Conversations ───────────────────────────────────────────────────
export const conversationStore = {
  getAll(): s.Conversation[] {
    return db.select().from(s.conversations).where(eq(s.conversations.isArchived, false)).orderBy(desc(s.conversations.updatedAt)).all();
  },
  getById(id: number): s.Conversation | undefined {
    return db.select().from(s.conversations).where(eq(s.conversations.id, id)).get();
  },
  create(data: s.InsertConversation): s.Conversation {
    return db.insert(s.conversations).values(data).returning().get();
  },
  update(id: number, data: Partial<s.InsertConversation>) {
    return db.update(s.conversations).set({ ...data, updatedAt: new Date().toISOString() }).where(eq(s.conversations.id, id)).returning().get();
  },
  delete(id: number) {
    db.delete(s.messages).where(eq(s.messages.conversationId, id)).run();
    db.delete(s.subtasks).where(
      inArray(s.subtasks.planId,
        db.select({ id: s.taskPlans.id }).from(s.taskPlans).where(eq(s.taskPlans.conversationId, id))
      )
    ).run();
    db.delete(s.taskPlans).where(eq(s.taskPlans.conversationId, id)).run();
    return db.delete(s.conversations).where(eq(s.conversations.id, id)).run();
  },
  bulkDelete(ids: number[]) {
    for (const id of ids) {
      this.delete(id);
    }
  },
  getByGroup(groupId: number): s.Conversation[] {
    return db.select().from(s.conversations)
      .where(eq(s.conversations.groupId, groupId))
      .orderBy(desc(s.conversations.updatedAt)).all();
  },
  getUngrouped(): s.Conversation[] {
    return db.select().from(s.conversations)
      .where(and(sql`${s.conversations.groupId} IS NULL`, eq(s.conversations.isArchived, false)))
      .orderBy(desc(s.conversations.updatedAt)).all();
  },
};

// ── Messages ────────────────────────────────────────────────────────
export const messageStore = {
  getByConversation(conversationId: number, limit = 500): s.Message[] {
    // Cap at 500 messages — context compression in agent-loop handles the rest.
    // Using DESC + reverse so we always get the MOST RECENT messages when capped.
    const rows = db.select().from(s.messages)
      .where(eq(s.messages.conversationId, conversationId))
      .orderBy(desc(s.messages.id))
      .limit(limit)
      .all();
    return rows.reverse(); // restore chronological order
  },
  create(data: s.InsertMessage): s.Message {
    const msg = db.insert(s.messages).values(data).returning().get();
    // Update conversation timestamp
    db.update(s.conversations).set({ updatedAt: new Date().toISOString() }).where(eq(s.conversations.id, data.conversationId)).run();
    return msg;
  },
  update(id: number, data: Partial<s.InsertMessage>): s.Message | undefined {
    return db.update(s.messages).set(data).where(eq(s.messages.id, id)).returning().get();
  },
  delete(id: number): void {
    db.delete(s.messages).where(eq(s.messages.id, id)).run();
  },
  deleteAfter(conversationId: number, afterId: number): void {
    // Delete all messages in a conversation with id > afterId
    db.delete(s.messages)
      .where(and(eq(s.messages.conversationId, conversationId), gt(s.messages.id, afterId)))
      .run();
  },
};

// ── Task Plans ──────────────────────────────────────────────────────
export const taskPlanStore = {
  getByConversation(conversationId: number): s.TaskPlan[] {
    return db.select().from(s.taskPlans).where(eq(s.taskPlans.conversationId, conversationId)).all();
  },
  create(data: s.InsertTaskPlan): s.TaskPlan {
    return db.insert(s.taskPlans).values(data).returning().get();
  },
  update(id: number, data: Partial<s.InsertTaskPlan>) {
    return db.update(s.taskPlans).set(data).where(eq(s.taskPlans.id, id)).returning().get();
  },
};

// ── Subtasks ────────────────────────────────────────────────────────
export const subtaskStore = {
  getByPlan(planId: number): s.Subtask[] {
    return db.select().from(s.subtasks).where(eq(s.subtasks.planId, planId)).orderBy(s.subtasks.orderIndex).all();
  },
  create(data: s.InsertSubtask): s.Subtask {
    return db.insert(s.subtasks).values(data).returning().get();
  },
  update(id: number, data: Partial<s.InsertSubtask>) {
    return db.update(s.subtasks).set(data).where(eq(s.subtasks.id, id)).returning().get();
  },
};

// ── Skills ──────────────────────────────────────────────────────────
export const skillStore = {
  getAll(): s.Skill[] {
    return db.select().from(s.skills).orderBy(desc(s.skills.updatedAt)).all();
  },
  getById(id: number): s.Skill | undefined {
    return db.select().from(s.skills).where(eq(s.skills.id, id)).get();
  },
  getByName(name: string): s.Skill | undefined {
    return db.select().from(s.skills).where(eq(s.skills.name, name)).get();
  },
  getEnabled(): s.Skill[] {
    return db.select().from(s.skills).where(and(eq(s.skills.isEnabled, true), eq(s.skills.approvalStatus, "approved"))).all();
  },
  getPending(): s.Skill[] {
    return db.select().from(s.skills).where(eq(s.skills.approvalStatus, "pending")).all();
  },
  create(data: s.InsertSkill): s.Skill {
    return db.insert(s.skills).values(data).returning().get();
  },
  update(id: number, data: Partial<s.InsertSkill>): s.Skill | undefined {
    return db.update(s.skills).set({ ...data, updatedAt: new Date().toISOString() }).where(eq(s.skills.id, id)).returning().get();
  },
  incrementUsage(id: number) {
    const skill = this.getById(id);
    if (!skill) return;
    db.update(s.skills).set({
      usageCount: skill.usageCount + 1,
      lastUsedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).where(eq(s.skills.id, id)).run();
  },
  delete(id: number) {
    db.delete(s.skillVersions).where(eq(s.skillVersions.skillId, id)).run();
    return db.delete(s.skills).where(eq(s.skills.id, id)).run();
  },
  saveVersion(skillId: number, version: number, instructions: string, systemPrompt: string | null, reason: string | null) {
    return db.insert(s.skillVersions).values({ skillId, version, instructions, systemPrompt, changeReason: reason }).returning().get();
  },
  getVersions(skillId: number) {
    return db.select().from(s.skillVersions).where(eq(s.skillVersions.skillId, skillId)).orderBy(desc(s.skillVersions.version)).all();
  },
};

// ── Apps ─────────────────────────────────────────────────────────────
export const appStore = {
  getAll(): s.App[] {
    return db.select().from(s.apps).orderBy(desc(s.apps.updatedAt)).all();
  },
  getById(id: number): s.App | undefined {
    return db.select().from(s.apps).where(eq(s.apps.id, id)).get();
  },
  getByName(name: string): s.App | undefined {
    return db.select().from(s.apps).where(eq(s.apps.name, name)).get();
  },
  getRunning(): s.App[] {
    return db.select().from(s.apps).where(eq(s.apps.status, "running")).all();
  },
  create(data: s.InsertApp): s.App {
    return db.insert(s.apps).values(data).returning().get();
  },
  update(id: number, data: Partial<s.InsertApp>): s.App | undefined {
    return db.update(s.apps).set({ ...data, updatedAt: new Date().toISOString() }).where(eq(s.apps.id, id)).returning().get();
  },
  delete(id: number) {
    return db.delete(s.apps).where(eq(s.apps.id, id)).run();
  },
  getNextPort(): number {
    const maxPort = sqlite.prepare("SELECT MAX(port) as max_port FROM apps WHERE port IS NOT NULL").get() as any;
    return (maxPort?.max_port || 9000) + 1;
  },
};

// ── Benchmarks ──────────────────────────────────────────────────────
export const benchmarkStore = {
  getAllSuites(): s.BenchmarkSuite[] {
    return db.select().from(s.benchmarkSuites).all();
  },
  getSuiteById(id: number): s.BenchmarkSuite | undefined {
    return db.select().from(s.benchmarkSuites).where(eq(s.benchmarkSuites.id, id)).get();
  },
  createSuite(data: s.InsertBenchmarkSuite): s.BenchmarkSuite {
    return db.insert(s.benchmarkSuites).values(data).returning().get();
  },
  deleteSuite(id: number) {
    db.delete(s.benchmarkRuns).where(eq(s.benchmarkRuns.suiteId, id)).run();
    return db.delete(s.benchmarkSuites).where(eq(s.benchmarkSuites.id, id)).run();
  },
  getRunsBySuite(suiteId: number): s.BenchmarkRun[] {
    return db.select().from(s.benchmarkRuns).where(eq(s.benchmarkRuns.suiteId, suiteId)).orderBy(desc(s.benchmarkRuns.createdAt)).all();
  },
  createRun(data: s.InsertBenchmarkRun): s.BenchmarkRun {
    return db.insert(s.benchmarkRuns).values(data).returning().get();
  },
  updateRun(id: number, data: Partial<s.InsertBenchmarkRun>) {
    return db.update(s.benchmarkRuns).set(data).where(eq(s.benchmarkRuns.id, id)).returning().get();
  },
  /**
   * Seed shipped-with-the-app benchmark suites. Idempotent and non-destructive:
   * a preset is inserted only if no suite with the same name exists, so re-runs
   * don't duplicate, user-created suites are untouched, and user edits to a
   * preset's prompts are preserved (we never overwrite an existing row).
   * Returns the number of suites newly inserted.
   */
  seedPresets(presets: { name: string; description: string; prompts: unknown[] }[]): number {
    const existing = new Set(
      db.select({ name: s.benchmarkSuites.name }).from(s.benchmarkSuites).all().map(r => r.name),
    );
    let inserted = 0;
    for (const preset of presets) {
      if (existing.has(preset.name)) continue;
      db.insert(s.benchmarkSuites).values({
        name: preset.name,
        description: preset.description,
        prompts: JSON.stringify(preset.prompts),
      }).run();
      inserted++;
    }
    return inserted;
  },
};

// ── Analytics ───────────────────────────────────────────────────────
export const analyticsStore = {
  record(data: s.InsertAnalyticsEvent): s.AnalyticsEvent {
    return db.insert(s.analyticsEvents).values(data).returning().get();
  },
  getRecent(limit: number = 100): s.AnalyticsEvent[] {
    return db.select().from(s.analyticsEvents).orderBy(desc(s.analyticsEvents.createdAt)).limit(limit).all();
  },
  getByDateRange(startDate: string, endDate: string): s.AnalyticsEvent[] {
    return db.select().from(s.analyticsEvents)
      .where(and(
        sql`${s.analyticsEvents.createdAt} >= ${startDate}`,
        sql`${s.analyticsEvents.createdAt} <= ${endDate}`
      ))
      .orderBy(s.analyticsEvents.createdAt).all();
  },
  getTokenUsageByModel(): { modelId: string; totalIn: number; totalOut: number; count: number }[] {
    return sqlite.prepare(`
      SELECT model_id as modelId,
        COALESCE(SUM(tokens_in), 0) as totalIn,
        COALESCE(SUM(tokens_out), 0) as totalOut,
        COUNT(*) as count
      FROM analytics_events
      WHERE model_id IS NOT NULL
      GROUP BY model_id
      ORDER BY count DESC
    `).all() as any[];
  },
  getDailyUsage(days: number = 30): { date: string; events: number; tokens: number; tokensIn: number; tokensOut: number }[] {
    return sqlite.prepare(`
      SELECT DATE(created_at) as date,
        COUNT(*) as events,
        COALESCE(SUM(tokens_in + tokens_out), 0) as tokens,
        COALESCE(SUM(tokens_in), 0) as tokensIn,
        COALESCE(SUM(tokens_out), 0) as tokensOut
      FROM analytics_events
      WHERE created_at >= DATE('now', '-' || ? || ' days')
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `).all(days) as any[];
  },
  getTaskTypeDistribution(): { taskType: string; count: number }[] {
    return sqlite.prepare(`
      SELECT task_type as taskType, COUNT(*) as count
      FROM analytics_events
      WHERE task_type IS NOT NULL
      GROUP BY task_type
      ORDER BY count DESC
    `).all() as any[];
  },
  getAverageResponseTime(): { modelId: string; avgMs: number }[] {
    return sqlite.prepare(`
      SELECT model_id as modelId, AVG(duration_ms) as avgMs
      FROM analytics_events
      WHERE model_id IS NOT NULL AND duration_ms IS NOT NULL
      GROUP BY model_id
      ORDER BY avgMs ASC
    `).all() as any[];
  },
  getTokenUsageByConversation(limit: number = 20): { conversationId: number; title: string; totalIn: number; totalOut: number; modelId: string | null; date: string }[] {
    return sqlite.prepare(`
      SELECT
        ae.metadata,
        COALESCE(SUM(ae.tokens_in), 0) as totalIn,
        COALESCE(SUM(ae.tokens_out), 0) as totalOut,
        ae.model_id as modelId,
        DATE(MAX(ae.created_at)) as date
      FROM analytics_events ae
      WHERE ae.event_type = 'chat'
      GROUP BY ae.model_id, DATE(ae.created_at)
      ORDER BY date DESC
      LIMIT ?
    `).all(limit) as any[];
  },
  getTokenUsageByConversationJoined(limit: number = 20): { conversationId: number | null; title: string; totalIn: number; totalOut: number; modelId: string | null; date: string }[] {
    // Join analytics_events with conversations via metadata JSON
    // analytics_events metadata may contain {conversationId}
    // Fall back to grouping by model+date if no conversation linkage
    return sqlite.prepare(`
      SELECT
        CAST(json_extract(ae.metadata, '$.conversationId') AS INTEGER) as conversationId,
        COALESCE(c.title, 'Unknown') as title,
        COALESCE(SUM(ae.tokens_in), 0) as totalIn,
        COALESCE(SUM(ae.tokens_out), 0) as totalOut,
        ae.model_id as modelId,
        DATE(MAX(ae.created_at)) as date
      FROM analytics_events ae
      LEFT JOIN conversations c
        ON c.id = CAST(json_extract(ae.metadata, '$.conversationId') AS INTEGER)
      WHERE ae.event_type = 'chat'
      GROUP BY json_extract(ae.metadata, '$.conversationId'), ae.model_id
      ORDER BY date DESC
      LIMIT ?
    `).all(limit) as any[];
  },
  getEfficiencyMetrics(): { totalEvents: number; successEvents: number; totalTokensIn: number; totalTokensOut: number; totalDurationMs: number; toolCallEvents: number } {
    return sqlite.prepare(`
      SELECT
        COUNT(*) as totalEvents,
        COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) as successEvents,
        COALESCE(SUM(tokens_in), 0) as totalTokensIn,
        COALESCE(SUM(tokens_out), 0) as totalTokensOut,
        COALESCE(SUM(duration_ms), 0) as totalDurationMs,
        COALESCE(SUM(CASE WHEN event_type = 'tool_call' THEN 1 ELSE 0 END), 0) as toolCallEvents
      FROM analytics_events
    `).get() as any;
  },
};

// ── Memory ──────────────────────────────────────────────────────────
export const memoryStore = {
  getAll(): s.MemoryEntry[] {
    return db.select().from(s.memoryEntries).orderBy(desc(s.memoryEntries.importance), desc(s.memoryEntries.updatedAt)).all();
  },
  /**
   * v16.40: Scoped getAll — returns general memories plus any project-specific ones.
   * scope: undefined = general only, 'project:123' = general + project:123
   */
  getScoped(scope?: string): s.MemoryEntry[] {
    if (!scope || scope === "general") {
      return db.select().from(s.memoryEntries)
        .where(eq(s.memoryEntries.scope, "general"))
        .orderBy(desc(s.memoryEntries.importance), desc(s.memoryEntries.updatedAt)).all();
    }
    // Project context: general + this project's memories, nothing else
    return sqlite.prepare(
      `SELECT * FROM memory_entries WHERE scope = 'general' OR scope = ? ORDER BY importance DESC, updated_at DESC`
    ).all(scope) as s.MemoryEntry[];
  },
  search(query: string, scope?: string): s.MemoryEntry[] {
    // Use FTS5 for full-text search, then filter by scope
    try {
      const results = sqlite.prepare(`
        SELECT m.* FROM memory_entries m
        JOIN memory_fts f ON m.id = f.rowid
        WHERE memory_fts MATCH ?
        ORDER BY rank
        LIMIT 20
      `).all(query) as s.MemoryEntry[];
      // v16.40: filter results to only show memories visible in this scope
      if (!scope || scope === "general") {
        return results.filter(r => r.scope === "general");
      }
      return results.filter(r => r.scope === "general" || r.scope === scope);
    } catch {
      // Fallback to LIKE if FTS not populated
      const allMatches = db.select().from(s.memoryEntries)
        .where(like(s.memoryEntries.content, `%${query}%`))
        .limit(20).all();
      if (!scope || scope === "general") {
        return allMatches.filter(r => r.scope === "general");
      }
      return allMatches.filter(r => r.scope === "general" || r.scope === scope);
    }
  },
  create(data: s.InsertMemoryEntry): s.MemoryEntry {
    const entry = db.insert(s.memoryEntries).values(data).returning().get();
    // Index in FTS
    try {
      sqlite.prepare("INSERT INTO memory_fts(rowid, content, category) VALUES (?, ?, ?)").run(entry.id, entry.content, entry.category);
    } catch { /* FTS table may not exist yet */ }
    return entry;
  },
  update(id: number, data: Partial<s.InsertMemoryEntry>) {
    const updated = db.update(s.memoryEntries).set({ ...data, updatedAt: new Date().toISOString() }).where(eq(s.memoryEntries.id, id)).returning().get();
    if (updated) {
      try {
        sqlite.prepare("UPDATE memory_fts SET content = ?, category = ? WHERE rowid = ?").run(updated.content, updated.category, id);
      } catch { }
    }
    return updated;
  },
  delete(id: number) {
    try { sqlite.prepare("DELETE FROM memory_fts WHERE rowid = ?").run(id); } catch { }
    return db.delete(s.memoryEntries).where(eq(s.memoryEntries.id, id)).run();
  },
};

// ── Chat Groups ─────────────────────────────────────────────────────
export const chatGroupStore = {
  getAll(): s.ChatGroup[] {
    return db.select().from(s.chatGroups).orderBy(s.chatGroups.orderIndex).all();
  },
  getById(id: number): s.ChatGroup | undefined {
    return db.select().from(s.chatGroups).where(eq(s.chatGroups.id, id)).get();
  },
  create(data: s.InsertChatGroup): s.ChatGroup {
    return db.insert(s.chatGroups).values(data).returning().get();
  },
  update(id: number, data: Partial<s.InsertChatGroup>): s.ChatGroup | undefined {
    return db.update(s.chatGroups).set(data).where(eq(s.chatGroups.id, id)).returning().get();
  },
  delete(id: number) {
    // Ungroup conversations in this group (don't delete them)
    db.update(s.conversations).set({ groupId: null }).where(eq(s.conversations.groupId, id)).run();
    return db.delete(s.chatGroups).where(eq(s.chatGroups.id, id)).run();
  },
};

// ── Projects ────────────────────────────────────────────────────────
export const projectStore = {
  getAll(): s.Project[] {
    return db.select().from(s.projects).where(eq(s.projects.status, "active")).orderBy(desc(s.projects.updatedAt)).all();
  },
  getById(id: number): s.Project | undefined {
    return db.select().from(s.projects).where(eq(s.projects.id, id)).get();
  },
  getByConversation(conversationId: number): s.Project | undefined {
    return db.select().from(s.projects).where(eq(s.projects.conversationId, conversationId)).get();
  },
  create(data: s.InsertProject): s.Project {
    return db.insert(s.projects).values(data).returning().get();
  },
  update(id: number, data: Partial<s.InsertProject>): s.Project | undefined {
    return db.update(s.projects).set({ ...data, updatedAt: new Date().toISOString() }).where(eq(s.projects.id, id)).returning().get();
  },
  delete(id: number) {
    return db.update(s.projects).set({ status: "archived" }).where(eq(s.projects.id, id)).run();
  },
};

// ── MCP Servers ────────────────────────────────────────────────────
export const mcpServerStore = {
  getAll(): s.McpServer[] {
    return db.select().from(s.mcpServers).orderBy(desc(s.mcpServers.createdAt)).all();
  },
  getById(id: number): s.McpServer | undefined {
    return db.select().from(s.mcpServers).where(eq(s.mcpServers.id, id)).get();
  },
  getEnabled(): s.McpServer[] {
    return db.select().from(s.mcpServers).where(eq(s.mcpServers.isEnabled, true)).all();
  },
  create(data: s.InsertMcpServer): s.McpServer {
    return db.insert(s.mcpServers).values(data).returning().get();
  },
  update(id: number, data: Partial<s.McpServer>): s.McpServer | undefined {
    return db.update(s.mcpServers).set(data).where(eq(s.mcpServers.id, id)).returning().get();
  },
  delete(id: number) {
    return db.delete(s.mcpServers).where(eq(s.mcpServers.id, id)).run();
  },
};

// ── Background Tasks ────────────────────────────────────────────────
export const backgroundTaskStore = {
  getAll(): s.BackgroundTask[] {
    return db.select().from(s.backgroundTasks).orderBy(desc(s.backgroundTasks.createdAt)).all();
  },
  getById(id: number): s.BackgroundTask | undefined {
    return db.select().from(s.backgroundTasks).where(eq(s.backgroundTasks.id, id)).get();
  },
  getByStatus(status: string): s.BackgroundTask[] {
    return db.select().from(s.backgroundTasks)
      .where(eq(s.backgroundTasks.status, status))
      .orderBy(s.backgroundTasks.createdAt)
      .all();
  },
  getScheduled(): s.BackgroundTask[] {
    return db.select().from(s.backgroundTasks)
      .where(eq(s.backgroundTasks.type, "scheduled"))
      .all();
  },
  create(data: s.InsertBackgroundTask): s.BackgroundTask {
    return db.insert(s.backgroundTasks).values(data).returning().get();
  },
  update(id: number, data: Partial<s.BackgroundTask>): s.BackgroundTask | undefined {
    return db.update(s.backgroundTasks).set(data).where(eq(s.backgroundTasks.id, id)).returning().get();
  },
  delete(id: number) {
    return db.delete(s.backgroundTasks).where(eq(s.backgroundTasks.id, id)).run();
  },
};

// ── Settings ────────────────────────────────────────────────────────
export const settingsStore = {
  get(key: string): string | null {
    const row = db.select().from(s.settings).where(eq(s.settings.key, key)).get();
    return row?.value ?? null;
  },
  set(key: string, value: string) {
    const existing = this.get(key);
    if (existing !== null) {
      return db.update(s.settings).set({ value, updatedAt: new Date().toISOString() }).where(eq(s.settings.key, key)).run();
    }
    return db.insert(s.settings).values({ key, value }).run();
  },
  getAll(): Record<string, string> {
    const rows = db.select().from(s.settings).all();
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  },
  initDefaults() {
    const defaults: Record<string, string> = {
      "searxng.url": "http://localhost:8888",
      "searxng.enabled": "false",
      "skills.autoApprove": "false",
      "network.lanServing": "false",   // Fix 6: default to localhost-only; user opts in for LAN
      "network.httpsEnabled": "false",  // Fix 4: HTTPS off by default; enable in Settings → Network
      "agent.appStoreConfirm": "true",  // v16.39: ask permission before deploying to app store (default on)
      "input.largePasteThreshold": "5000", // v16.40: chars before paste auto-converts to .txt attachment
      "paths.projectsRoot": "", // v16.46: custom projects folder (empty = ~/projects default)
      "paths.showWorkspaceChatsInSidebar": "false", // v16.46: hide workspace-linked chats from chat sidebar by default
      "docker.executionTimeout": "120",
      "docker.memoryLimit": "512m",
      "docker.cpuLimit": "2",
      "theme": "cyberpunk",
      "contextTokenBudget": "96000", // 96k tokens default — suitable for 128k context models
      "autoRouting": "true",
      "comfyuiHost": "127.0.0.1",
      "comfyuiPort": "8188",
      "comfyuiAutoApprove": "false",
      "comfyuiMaxConcurrent": "1",
    };
    for (const [key, value] of Object.entries(defaults)) {
      if (this.get(key) === null) this.set(key, value);
    }
  },
};

// ── Generated Images ────────────────────────────────────────────────
export const generatedImageStore = {
  getAll(): s.GeneratedImage[] {
    return db.select().from(s.generatedImages).orderBy(desc(s.generatedImages.createdAt)).all();
  },
  getById(id: number): s.GeneratedImage | undefined {
    return db.select().from(s.generatedImages).where(eq(s.generatedImages.id, id)).get();
  },
  getFavorites(): s.GeneratedImage[] {
    return db.select().from(s.generatedImages).where(eq(s.generatedImages.isFavorite, true)).orderBy(desc(s.generatedImages.createdAt)).all();
  },
  getByType(type: string): s.GeneratedImage[] {
    return db.select().from(s.generatedImages).where(eq(s.generatedImages.generationType, type)).orderBy(desc(s.generatedImages.createdAt)).all();
  },
  getByConversation(conversationId: number): s.GeneratedImage[] {
    return db.select().from(s.generatedImages).where(eq(s.generatedImages.conversationId, conversationId)).orderBy(desc(s.generatedImages.createdAt)).all();
  },
  getByProject(projectId: number): s.GeneratedImage[] {
    return db.select().from(s.generatedImages).where(eq(s.generatedImages.projectId, projectId)).orderBy(desc(s.generatedImages.createdAt)).all();
  },
  create(data: s.InsertGeneratedImage): s.GeneratedImage {
    return db.insert(s.generatedImages).values(data).returning().get();
  },
  toggleFavorite(id: number): s.GeneratedImage | undefined {
    const img = this.getById(id);
    if (!img) return undefined;
    return db.update(s.generatedImages).set({ isFavorite: !img.isFavorite }).where(eq(s.generatedImages.id, id)).returning().get();
  },
  delete(id: number) {
    return db.delete(s.generatedImages).where(eq(s.generatedImages.id, id)).run();
  },
  search(keyword: string) {
    return db.select().from(s.generatedImages)
      .where(like(s.generatedImages.prompt, `%${keyword}%`))
      .orderBy(desc(s.generatedImages.createdAt)).all();
  },
};

// ── ComfyUI Workflows ───────────────────────────────────────────────
export const workflowStore = {
  getAll(): s.ComfyuiWorkflow[] {
    return db.select().from(s.comfyuiWorkflows).orderBy(desc(s.comfyuiWorkflows.updatedAt)).all();
  },
  getById(id: number): s.ComfyuiWorkflow | undefined {
    return db.select().from(s.comfyuiWorkflows).where(eq(s.comfyuiWorkflows.id, id)).get();
  },
  getByCategory(category: string): s.ComfyuiWorkflow[] {
    return db.select().from(s.comfyuiWorkflows).where(eq(s.comfyuiWorkflows.category, category)).all();
  },
  create(data: s.InsertComfyuiWorkflow): s.ComfyuiWorkflow {
    return db.insert(s.comfyuiWorkflows).values(data).returning().get();
  },
  update(id: number, data: Partial<s.InsertComfyuiWorkflow>): s.ComfyuiWorkflow | undefined {
    return db.update(s.comfyuiWorkflows).set({ ...data, updatedAt: new Date().toISOString() }).where(eq(s.comfyuiWorkflows.id, id)).returning().get();
  },
  incrementUsage(id: number) {
    const wf = this.getById(id);
    if (!wf) return;
    db.update(s.comfyuiWorkflows).set({
      usageCount: wf.usageCount + 1,
      lastUsedAt: new Date().toISOString(),
    }).where(eq(s.comfyuiWorkflows.id, id)).run();
  },
  delete(id: number) {
    return db.delete(s.comfyuiWorkflows).where(eq(s.comfyuiWorkflows.id, id)).run();
  },
};

// ── Path Helpers ─────────────────────────────────────────────────────
import os from "os";
import path from "path";

/** Resolved projects root — uses setting if set, otherwise ~/projects */
export function getProjectsRoot(): string {
  const custom = settingsStore.get("paths.projectsRoot");
  if (custom && custom.trim()) {
    // Expand ~ in the stored path
    return custom.trim().startsWith("~")
      ? path.join(os.homedir(), custom.trim().slice(1))
      : custom.trim();
  }
  return path.join(os.homedir(), "projects");
}
