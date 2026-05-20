/**
 * Skill Tools — Agent2077 skill library management with progressive disclosure.
 *
 * skill_list  — compact index of all available skills (name + one-line description)
 * skill_view  — load full SKILL instructions on demand
 * skill_create — save a new skill to the library
 * skill_edit   — update an existing skill
 */
import { registerTool, type ToolResult } from "./registry.js";
import { skillStore } from "../storage.js";

// ── skill_list ─────────────────────────────────────────────────────────

registerTool("skill_list", {
  category: "skill",
  requiresApproval: false,
  definition: {
    type: "function",
    function: {
      name: "skill_list",
      description:
        "List all available skills with a compact one-line description each. " +
        "Use this to discover skills before calling skill_view to load full instructions.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description: "Filter by category (optional). If omitted, all skills are returned.",
          },
        },
        required: [],
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    try {
      let skills = skillStore.getEnabled();
      if (args.category) {
        skills = skills.filter(s => s.category === args.category);
      }
      if (skills.length === 0) {
        return { success: true, output: "No skills available." };
      }
      const lines = skills.map(s =>
        `- **${s.name}** [${s.category}] (used ${s.usageCount}x): ${s.description}`
      );
      return {
        success: true,
        output: `${skills.length} skill(s) available. Use skill_view to load full instructions.\n\n${lines.join("\n")}`,
      };
    } catch (e: any) {
      return { success: false, output: `skill_list error: ${e.message}` };
    }
  },
});

// ── skill_view ─────────────────────────────────────────────────────────

registerTool("skill_view", {
  category: "skill",
  requiresApproval: false,
  definition: {
    type: "function",
    function: {
      name: "skill_view",
      description:
        "Load the full instructions for a specific skill by name. " +
        "Always call skill_list first to discover available skills, " +
        "then use skill_view to load the one(s) relevant to your current task.",
      parameters: {
        type: "object",
        required: ["name"],
        properties: {
          name: {
            type: "string",
            description: "Exact skill name as returned by skill_list.",
          },
        },
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    try {
      const name = args.name as string;
      const skill = skillStore.getByName(name);
      if (!skill) {
        const all = skillStore.getEnabled().map(s => s.name).join(", ");
        return {
          success: false,
          output: `Skill "${name}" not found. Available skills: ${all || "(none)"}`,
        };
      }

      // Increment usage count
      skillStore.incrementUsage(skill.id);

      let output = `# Skill: ${skill.name}\n`;
      output += `**Category:** ${skill.category} | **Version:** ${skill.version} | **Used:** ${skill.usageCount + 1}x\n`;
      output += `**Description:** ${skill.description}\n\n`;
      if (skill.systemPrompt) {
        output += `## System Prompt Override\n${skill.systemPrompt}\n\n`;
      }
      output += `## Instructions\n${skill.instructions}`;

      return { success: true, output };
    } catch (e: any) {
      return { success: false, output: `skill_view error: ${e.message}` };
    }
  },
});

// ── skill_create ───────────────────────────────────────────────────────

registerTool("skill_create", {
  category: "skill",
  requiresApproval: false,
  definition: {
    type: "function",
    function: {
      name: "skill_create",
      description:
        "Save a new skill to the skill library for future reuse. " +
        "Call this after completing a complex task (5+ tool calls), fixing a tricky error, " +
        "or discovering a non-trivial workflow — so you can reuse it next time.",
      parameters: {
        type: "object",
        required: ["name", "description", "instructions"],
        properties: {
          name: {
            type: "string",
            description: "Short unique skill name (e.g. 'deploy_react_app', 'debug_python_import_error').",
          },
          description: {
            type: "string",
            description: "One-line description of what this skill does.",
          },
          category: {
            type: "string",
            description: "Category: general | coding | research | creative | math | system (default: general).",
          },
          instructions: {
            type: "string",
            description: "Step-by-step procedure. Be specific — include exact commands, common pitfalls, and verification steps.",
          },
          systemPrompt: {
            type: "string",
            description: "Optional system prompt override for when this skill is active.",
          },
          triggerPatterns: {
            type: "string",
            description: "JSON array of regex patterns that activate this skill (e.g. '[\"coding\", \"deploy\"]').",
          },
        },
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    try {
      const existing = skillStore.getByName(args.name as string);
      if (existing) {
        return {
          success: false,
          output: `Skill "${args.name}" already exists. Use skill_edit to update it.`,
        };
      }
      const skill = skillStore.create({
        name: args.name as string,
        description: args.description as string,
        category: (args.category as string) || "general",
        instructions: args.instructions as string,
        systemPrompt: (args.systemPrompt as string) || null,
        triggerPatterns: (args.triggerPatterns as string) || null,
        isEnabled: true,
        createdBy: "agent",
        approvalStatus: "approved",
        version: 1,
      });
      return {
        success: true,
        output: `Skill "${skill.name}" created (id=${skill.id}). It is now available via skill_list and skill_view.`,
      };
    } catch (e: any) {
      return { success: false, output: `skill_create error: ${e.message}` };
    }
  },
});

// ── skill_edit ─────────────────────────────────────────────────────────

registerTool("skill_edit", {
  category: "skill",
  requiresApproval: false,
  definition: {
    type: "function",
    function: {
      name: "skill_edit",
      description:
        "Update an existing skill. " +
        "Call this when you find a skill is outdated, incomplete, or incorrect — don't wait to be asked. " +
        "Only include fields you want to change.",
      parameters: {
        type: "object",
        required: ["name"],
        properties: {
          name: {
            type: "string",
            description: "Name of the skill to update.",
          },
          description: { type: "string", description: "New description." },
          instructions: { type: "string", description: "New instructions." },
          category: { type: "string", description: "New category." },
          systemPrompt: { type: "string", description: "New system prompt override." },
          triggerPatterns: { type: "string", description: "New JSON array of trigger patterns." },
          changeReason: { type: "string", description: "Why you're updating this skill." },
        },
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    try {
      const name = args.name as string;
      const skill = skillStore.getByName(name);
      if (!skill) {
        return { success: false, output: `Skill "${name}" not found. Use skill_list to see available skills.` };
      }

      // Save the current version before updating
      skillStore.saveVersion(skill.id, skill.version, skill.instructions, skill.systemPrompt, args.changeReason as string || null);

      const updates: Record<string, any> = {};
      if (args.description !== undefined) updates.description = args.description;
      if (args.instructions !== undefined) updates.instructions = args.instructions;
      if (args.category !== undefined) updates.category = args.category;
      if (args.systemPrompt !== undefined) updates.systemPrompt = args.systemPrompt;
      if (args.triggerPatterns !== undefined) updates.triggerPatterns = args.triggerPatterns;
      updates.version = skill.version + 1;

      const updated = skillStore.update(skill.id, updates);
      return {
        success: true,
        output: `Skill "${name}" updated to v${updated?.version}.${args.changeReason ? ` Reason: ${args.changeReason}` : ""}`,
      };
    } catch (e: any) {
      return { success: false, output: `skill_edit error: ${e.message}` };
    }
  },
});
