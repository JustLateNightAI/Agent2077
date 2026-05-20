/**
 * App Deployment Tool — Deploys web apps to the Agent2077 App Store
 * Creates Docker containers from source files and registers them
 */
import { registerTool, type ToolResult, type ToolContext } from "./registry.js";
import { dockerManager } from "../docker/manager.js";
import { appStore } from "../storage.js";
import path from "path";
import fs from "fs";

const WORKSPACE_DIR = path.join(process.cwd(), "workspace");
const APPS_DIR = path.join(WORKSPACE_DIR, "apps");

// Default Dockerfile for static HTML/JS apps served by nginx
function staticDockerfile(entryFile: string = "index.html"): string {
  return `FROM nginx:alpine
COPY . /usr/share/nginx/html/
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]`;
}

// Dockerfile for Node.js apps
function nodeDockerfile(entryFile: string = "server.js"): string {
  return `FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --production 2>/dev/null || true
COPY . .
EXPOSE 8080
CMD ["node", "${entryFile}"]`;
}

// Dockerfile for Python apps
function pythonDockerfile(entryFile: string = "app.py"): string {
  return `FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install -r requirements.txt 2>/dev/null || true
COPY . .
EXPOSE 8080
CMD ["python", "${entryFile}"]`;
}

registerTool("deploy_app", {
  category: "docker",
  requiresApproval: true, // ALWAYS confirm with user before deploying
  definition: {
    type: "function",
    function: {
      name: "deploy_app",
      description:
        "Deploy a web application to the Agent2077 App Store. ONLY use this when the user EXPLICITLY asks you to build, create, or deploy an app/game/tool. Do NOT call this tool unless the user's message specifically requests an app. This is NOT for generating images, answering questions, writing code snippets, or any other task. When building apps, aim for professional production quality — clean UI, proper error handling, responsive design, no placeholder content.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Display name for the app (e.g., 'AgentPaint', 'Calculator', 'Snake Game')",
          },
          description: {
            type: "string",
            description: "Short description of what the app does (max 120 characters)",
            maxLength: 120,
          },
          category: {
            type: "string",
            enum: ["tool", "game", "web", "utility", "media"],
            description: "App category for the store",
          },
          type: {
            type: "string",
            enum: ["static", "node", "python", "custom"],
            description:
              "App type: 'static' for HTML/JS/CSS, 'node' for Node.js, 'python' for Python, 'custom' for a provided Dockerfile",
          },
          files: {
            type: "object",
            description:
              "Object mapping file paths to file contents. Example: { 'index.html': '<html>...</html>', 'style.css': 'body { ... }', 'app.js': 'console.log(...)' }",
          },
          icon: {
            type: "string",
            description: "Emoji icon for the app (default: 📦)",
          },
          entryFile: {
            type: "string",
            description:
              "Main entry file (default: 'index.html' for static, 'server.js' for node, 'app.py' for python)",
          },
          dockerfile: {
            type: "string",
            description: "Custom Dockerfile contents (only for type='custom')",
          },
          internalPort: {
            type: "number",
            description: "Port the app listens on inside the container (default: 80 for static, 8080 for node/python)",
          },
        },
        required: ["name", "description", "type", "files"],
      },
    },
  },
  async execute(args, context): Promise<ToolResult> {
    const {
      name,
      category = "tool",
      type,
      files,
      icon = "📦",
      entryFile,
      dockerfile: customDockerfile,
      internalPort: customPort,
    } = args;
    // Clamp description to 120 chars in case the model over-generated
    const description: string = typeof args.description === "string"
      ? args.description.slice(0, 120)
      : String(args.description || "").slice(0, 120);

    // Check Docker is available
    if (!dockerManager.isReady()) {
      return {
        success: false,
        output:
          "Docker is not available. Cannot deploy apps. Make sure Docker is running: sudo systemctl start docker",
      };
    }

    let app: any = null;

    try {
      // 1. Determine defaults based on type
      let defaultEntry: string;
      let defaultPort: number;
      let dockerfileContent: string;

      switch (type) {
        case "static":
          defaultEntry = entryFile || "index.html";
          defaultPort = customPort || 80;
          dockerfileContent = customDockerfile || staticDockerfile(defaultEntry);
          break;
        case "node":
          defaultEntry = entryFile || "server.js";
          defaultPort = customPort || 8080;
          dockerfileContent = customDockerfile || nodeDockerfile(defaultEntry);
          break;
        case "python":
          defaultEntry = entryFile || "app.py";
          defaultPort = customPort || 8080;
          dockerfileContent = customDockerfile || pythonDockerfile(defaultEntry);
          break;
        case "custom":
          if (!customDockerfile) {
            return { success: false, output: "Custom type requires a 'dockerfile' parameter" };
          }
          defaultEntry = entryFile || "index.html";
          defaultPort = customPort || 8080;
          dockerfileContent = customDockerfile;
          break;
        default:
          return { success: false, output: `Unknown app type: ${type}. Use: static, node, python, or custom` };
      }

      // 2. Check if an app with this name already exists — UPDATE instead of duplicate
      const existing = appStore.getByName(name);
      let isUpdate = false;
      let oldVersion = 0;

      if (existing) {
        isUpdate = true;
        oldVersion = (existing as any).version || 1;
        const newVersion = oldVersion + 1;

        // Backup the current build directory (keep up to 3 versions)
        const currentBuildDir = path.join(APPS_DIR, `app-${existing.id}`);
        const backupDir = path.join(APPS_DIR, `app-${existing.id}-v${oldVersion}`);
        if (fs.existsSync(currentBuildDir)) {
          // Copy current to versioned backup
          try {
            if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
            fs.cpSync(currentBuildDir, backupDir, { recursive: true });
            console.log(`[AppDeploy] Backed up v${oldVersion} to ${backupDir}`);
          } catch (err: any) {
            console.warn(`[AppDeploy] Failed to backup v${oldVersion}:`, err.message);
          }

          // Prune old backups — keep only the last 3 versions
          for (let v = oldVersion - 3; v >= 1; v--) {
            const oldBackup = path.join(APPS_DIR, `app-${existing.id}-v${v}`);
            if (fs.existsSync(oldBackup)) {
              try {
                fs.rmSync(oldBackup, { recursive: true, force: true });
                console.log(`[AppDeploy] Pruned old backup v${v}`);
              } catch { /* best effort */ }
            }
          }
        }

        // Update the existing app record
        appStore.update(existing.id, {
          description,
          category,
          dockerfile: dockerfileContent,
          iconEmoji: icon,
          status: "building",
          version: newVersion as any,
          createdByConversation: context.conversationId,
        });

        app = appStore.getById(existing.id);
        console.log(`[AppDeploy] Updating existing app "${name}" (id=${existing.id}) to v${newVersion}`);
      } else {
        // 3a. Get next available port
        const hostPort = appStore.getNextPort();

        // 3b. Register new app in the database
        app = appStore.create({
          name,
          description,
          category,
          imageName: `agent2077-app-${name.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
          port: hostPort,
          internalPort: defaultPort,
          status: "building",
          dockerfile: dockerfileContent,
          iconEmoji: icon,
          createdByConversation: context.conversationId,
        });
        console.log(`[AppDeploy] Creating new app "${name}" (id=${app.id})`);
      }

      const hostPort = app.port;

      // 4. Write files to build directory (overwrites existing on update)
      const buildDir = path.join(APPS_DIR, `app-${app.id}`);
      // Clear old files on update to avoid stale files from previous version
      if (isUpdate && fs.existsSync(buildDir)) {
        const oldFiles = fs.readdirSync(buildDir);
        for (const f of oldFiles) {
          fs.rmSync(path.join(buildDir, f), { recursive: true, force: true });
        }
      }
      if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });

      // Write all provided files
      if (files && typeof files === "object") {
        for (const [filePath, content] of Object.entries(files)) {
          const fullPath = path.join(buildDir, filePath);
          const dir = path.dirname(fullPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(fullPath, content as string);
        }
      }

      // Write Dockerfile
      fs.writeFileSync(path.join(buildDir, "Dockerfile"), dockerfileContent);

      // 5. Deploy via Docker manager (builds image + starts container for testing)
      const result = await dockerManager.deployApp(
        app.id,
        dockerfileContent,
        buildDir,
        hostPort,
        existing ? existing.internalPort : defaultPort
      );

      // 6. App is now running for testing
      const testUrl = `http://localhost:${hostPort}`;
      const versionStr = isUpdate ? ` (v${oldVersion + 1}, updated from v${oldVersion})` : "";

      return {
        success: true,
        output: `App "${name}" ${isUpdate ? "updated" : "built"} and deployed successfully!${versionStr}\n` +
          `  Status: running (for testing)\n` +
          `  Port: ${hostPort}\n` +
          `  Test URL: ${testUrl}\n` +
          `  Container: ${result.containerId.slice(0, 12)}\n` +
          (isUpdate ? `  Previous version backed up as v${oldVersion} (up to 3 versions kept)\n` : "") +
          `\nThe app is now running so you can verify it works. ` +
          `When you're done testing, call stop_app to stop it. ` +
          `The user will launch it from the App Store when they want to use it.\n` +
          `\nIMPORTANT: After confirming the app works correctly, call stop_app with appId ${app.id} ` +
          `so it appears as 'stopped' in the App Store for the user to launch on demand.`,
        metadata: { appId: app.id, port: hostPort, containerId: result.containerId, version: isUpdate ? oldVersion + 1 : 1 },
      };
    } catch (err: any) {
      // On failure for NEW apps: clean up DB entry + build dir
      // On failure for UPDATES: restore from backup if possible
      if (app?.id) {
        const buildDir = path.join(APPS_DIR, `app-${app.id}`);
        if (!existing) {
          // New app failed — remove everything
          try {
            if (fs.existsSync(buildDir)) fs.rmSync(buildDir, { recursive: true, force: true });
            appStore.delete(app.id);
          } catch { /* best effort cleanup */ }
        } else {
          // Update failed — try to restore previous version
          try {
            const backupDir = path.join(APPS_DIR, `app-${app.id}-v${(existing as any).version || 1}`);
            if (fs.existsSync(backupDir)) {
              if (fs.existsSync(buildDir)) fs.rmSync(buildDir, { recursive: true, force: true });
              fs.cpSync(backupDir, buildDir, { recursive: true });
              appStore.update(app.id, { status: "stopped", errorLog: `Update failed: ${err.message}. Restored v${(existing as any).version || 1}.` });
              console.log(`[AppDeploy] Update failed, restored backup`);
            } else {
              appStore.update(app.id, { status: "error", errorLog: err.message });
            }
          } catch { appStore.update(app.id, { status: "error", errorLog: err.message }); }
        }
      }
      return {
        success: false,
        output: `Failed to deploy app: ${err.message}`,
      };
    }
  },
});

// ── cleanup_apps: remove all errored/building orphans ──────────────
registerTool("cleanup_apps", {
  category: "docker",
  definition: {
    type: "function",
    function: {
      name: "cleanup_apps",
      description:
        "Remove all apps in 'error' or 'building' state from the App Store. " +
        "Use this to clean up after failed deployments.",
      parameters: { type: "object", properties: {} },
    },
  },
  async execute(_args, _context): Promise<ToolResult> {
    const allApps = appStore.getAll();
    const orphans = allApps.filter(
      (a) => a.status === "error" || a.status === "building"
    );
    if (orphans.length === 0) {
      return { success: true, output: "No errored or stale apps to clean up." };
    }
    const removed: string[] = [];
    for (const app of orphans) {
      try {
        await dockerManager.removeApp(app.id);
      } catch {
        // removeApp may fail if no container — still delete from DB
        appStore.delete(app.id);
      }
      // Clean up build dir
      const dir = path.join(APPS_DIR, `app-${app.id}`);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      removed.push(`${app.name} (id ${app.id})`);
    }
    return {
      success: true,
      output: `Cleaned up ${removed.length} app(s): ${removed.join(", ")}`,
    };
  },
});

// ── rollback_app: roll back to a previous version ──────────────
registerTool("rollback_app", {
  category: "docker",
  definition: {
    type: "function",
    function: {
      name: "rollback_app",
      description:
        "Roll back an app in the App Store to a previous version. " +
        "The current version is backed up before rollback. " +
        "Use this if the latest update broke something.",
      parameters: {
        type: "object",
        properties: {
          appId: {
            type: "number",
            description: "The app ID to roll back",
          },
          targetVersion: {
            type: "number",
            description: "The version number to roll back to (e.g., 1, 2). If not specified, rolls back to the most recent previous version.",
          },
        },
        required: ["appId"],
      },
    },
  },
  async execute(args, _context): Promise<ToolResult> {
    const { appId, targetVersion } = args;

    const app = appStore.getById(appId);
    if (!app) return { success: false, output: `App with id ${appId} not found` };

    const currentVersion = (app as any).version || 1;
    if (currentVersion <= 1 && !targetVersion) {
      return { success: false, output: `App "${app.name}" is at version 1 — nothing to roll back to.` };
    }

    // Determine target version
    let rollbackTo = targetVersion;
    if (!rollbackTo) {
      // Find the most recent backup
      for (let v = currentVersion - 1; v >= 1; v--) {
        const backupDir = path.join(APPS_DIR, `app-${appId}-v${v}`);
        if (fs.existsSync(backupDir)) {
          rollbackTo = v;
          break;
        }
      }
    }

    if (!rollbackTo) {
      return { success: false, output: `No previous version backups found for "${app.name}".` };
    }

    const backupDir = path.join(APPS_DIR, `app-${appId}-v${rollbackTo}`);
    if (!fs.existsSync(backupDir)) {
      return { success: false, output: `Backup for version ${rollbackTo} not found.` };
    }

    const buildDir = path.join(APPS_DIR, `app-${appId}`);

    try {
      // Backup the current version before rolling back
      const currentBackupDir = path.join(APPS_DIR, `app-${appId}-v${currentVersion}`);
      if (fs.existsSync(buildDir) && !fs.existsSync(currentBackupDir)) {
        fs.cpSync(buildDir, currentBackupDir, { recursive: true });
        console.log(`[Rollback] Saved current v${currentVersion} as backup`);
      }

      // Wipe current build dir and copy backup
      if (fs.existsSync(buildDir)) {
        fs.rmSync(buildDir, { recursive: true, force: true });
      }
      fs.cpSync(backupDir, buildDir, { recursive: true });

      // Update DB record
      appStore.update(appId, {
        version: rollbackTo as any,
        status: "stopped",
        errorLog: null,
      });

      // Rebuild Docker container from the restored files
      if (app.dockerfile && dockerManager.isReady()) {
        try {
          const result = await dockerManager.deployApp(
            appId,
            app.dockerfile,
            buildDir,
            app.port!,
            app.internalPort
          );
          // Stop after rebuild so it's ready to launch
          await dockerManager.stopApp(appId);
        } catch (err: any) {
          console.warn(`[Rollback] Docker rebuild failed:`, err.message);
          // Files are restored even if Docker rebuild fails
        }
      }

      console.log(`[Rollback] App "${app.name}" rolled back from v${currentVersion} to v${rollbackTo}`);

      return {
        success: true,
        output: `App "${app.name}" rolled back to version ${rollbackTo} (was v${currentVersion}).\n` +
          `The previous v${currentVersion} has been saved as a backup.\n` +
          `The app is now stopped — launch it from the App Store to test.`,
        metadata: { appId, previousVersion: currentVersion, restoredVersion: rollbackTo },
      };
    } catch (err: any) {
      return {
        success: false,
        output: `Rollback failed: ${err.message}`,
      };
    }
  },
});

registerTool("stop_app", {
  category: "docker",
  definition: {
    type: "function",
    function: {
      name: "stop_app",
      description:
        "Stop a running app in the App Store. Use this after deploying and verifying an app works correctly, so it appears as 'stopped' in the App Store for the user to launch on demand.",
      parameters: {
        type: "object",
        properties: {
          appId: {
            type: "number",
            description: "The app ID returned by deploy_app",
          },
        },
        required: ["appId"],
      },
    },
  },
  async execute(args, context): Promise<ToolResult> {
    const { appId } = args;
    try {
      await dockerManager.stopApp(appId);
      const app = appStore.getById(appId);
      return {
        success: true,
        output: `App "${app?.name || appId}" stopped. It is now listed in the App Store and the user can launch it whenever they want.`,
      };
    } catch (err: any) {
      return {
        success: false,
        output: `Failed to stop app: ${err.message}`,
      };
    }
  },
});
