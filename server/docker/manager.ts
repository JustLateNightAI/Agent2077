/**
 * Docker Manager — Manages execution sandboxes and persistent app containers
 * Communicates with Docker daemon via socket
 */
import Dockerode from "dockerode";
import { settingsStore, appStore } from "../storage.js";
import { analyticsStore } from "../storage.js";
import path from "path";
import fs from "fs";

const docker = new Dockerode({ socketPath: "/var/run/docker.sock" });

// Base images for different languages
const LANGUAGE_IMAGES: Record<string, { image: string; cmd: (code: string) => string[]; needsExecTmp?: boolean }> = {
  python: {
    image: "python:3.12-slim",
    cmd: (code) => ["python", "-c", code],
  },
  javascript: {
    image: "node:22-slim",
    cmd: (code) => ["node", "-e", code],
  },
  typescript: {
    image: "node:22-slim",
    cmd: (code) => ["npx", "--yes", "tsx", "-e", code],
  },
  bash: {
    image: "ubuntu:24.04",
    cmd: (code) => ["bash", "-c", code],
  },
  rust: {
    image: "rust:slim",
    needsExecTmp: true, // Compiles to /tmp — needs exec permission
    cmd: (code) => ["bash", "-c", `echo '${code.replace(/'/g, "'\\''")}' > /tmp/main.rs && rustc /tmp/main.rs -o /tmp/main && /tmp/main`],
  },
  go: {
    image: "golang:1.22-alpine",
    needsExecTmp: true,
    cmd: (code) => ["bash", "-c", `echo '${code.replace(/'/g, "'\\''")}' > /tmp/main.go && go run /tmp/main.go`],
  },
  c: {
    image: "gcc:latest",
    needsExecTmp: true,
    cmd: (code) => ["bash", "-c", `echo '${code.replace(/'/g, "'\\''")}' > /tmp/main.c && gcc /tmp/main.c -o /tmp/main && /tmp/main`],
  },
  cpp: {
    image: "gcc:latest",
    needsExecTmp: true,
    cmd: (code) => ["bash", "-c", `echo '${code.replace(/'/g, "'\\''")}' > /tmp/main.cpp && g++ /tmp/main.cpp -o /tmp/main && /tmp/main`],
  },
};

// Workspace directory for persistent file sharing between containers
const WORKSPACE_DIR = path.join(process.cwd(), "workspace");

export interface CodeExecRequest {
  language: string;
  code: string;
  timeout: number;
  packages: string[];
  requestId: string;
  workdir?: string;
}

export interface CodeExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

class DockerManager {
  private ready = false;

  async init() {
    // Ensure workspace directory exists
    if (!fs.existsSync(WORKSPACE_DIR)) {
      fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    }

    // Check Docker connection
    try {
      await docker.ping();
      this.ready = true;
      console.log("[Docker] Connected to Docker daemon");

      // Pull common base images in background
      this.pullBaseImages();
    } catch (err: any) {
      console.warn("[Docker] Docker daemon not available:", err.message);
      console.warn("[Docker] Code execution and app deployment will be disabled");
      this.ready = false;
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  private async pullBaseImages() {
    const images = ["python:3.12-slim", "node:22-slim", "ubuntu:24.04"];
    for (const image of images) {
      try {
        const exists = await docker.listImages({ filters: { reference: [image] } });
        if (exists.length === 0) {
          console.log(`[Docker] Pulling ${image}...`);
          await new Promise<void>((resolve, reject) => {
            docker.pull(image, (err: any, stream: any) => {
              if (err) return reject(err);
              docker.modem.followProgress(stream, (err2: any) => {
                if (err2) reject(err2);
                else {
                  console.log(`[Docker] Pulled ${image}`);
                  resolve();
                }
              });
            });
          });
        }
      } catch (err: any) {
        console.warn(`[Docker] Failed to pull ${image}:`, err.message);
      }
    }
  }

  /**
   * Execute code in an ephemeral container
   */
  async executeCode(req: CodeExecRequest): Promise<CodeExecResult> {
    if (!this.ready) {
      return { stdout: "", stderr: "Docker is not available. Code execution is disabled.", exitCode: 1, timedOut: false, durationMs: 0 };
    }

    const langConfig = LANGUAGE_IMAGES[req.language];
    if (!langConfig) {
      return { stdout: "", stderr: `Unsupported language: ${req.language}`, exitCode: 1, timedOut: false, durationMs: 0 };
    }

    const startTime = Date.now();
    const containerName = `agent2077-exec-${req.requestId.slice(0, 8)}-${Date.now()}`;
    const memLimit = settingsStore.get("docker.memoryLimit") || "512m";
    const cpuLimit = parseInt(settingsStore.get("docker.cpuLimit") || "2");

    // Build install + run command
    let fullCode = req.code;
    if (req.packages.length > 0) {
      if (req.language === "python") {
        fullCode = `import subprocess, sys\nsubprocess.check_call([sys.executable, '-m', 'pip', 'install', '-q', ${req.packages.map(p => `'${p}'`).join(", ")}])\n${req.code}`;
      } else if (req.language === "javascript" || req.language === "typescript") {
        const installCmd = `npm install --no-save ${req.packages.join(" ")} 2>/dev/null && `;
        fullCode = installCmd + langConfig.cmd(req.code).join(" ");
        // Override to use bash for compound command
        return this.executeRaw(containerName, langConfig.image, ["bash", "-c", fullCode], req.timeout, memLimit, cpuLimit, startTime, langConfig.needsExecTmp);
      }
    }

    return this.executeRaw(containerName, langConfig.image, langConfig.cmd(fullCode), req.timeout, memLimit, cpuLimit, startTime, langConfig.needsExecTmp);
  }

  private async executeRaw(
    containerName: string,
    image: string,
    cmd: string[],
    timeout: number,
    memLimit: string,
    cpuLimit: number,
    startTime: number,
    needsExecTmp?: boolean
  ): Promise<CodeExecResult> {
    let container: Dockerode.Container | null = null;

    try {
      // Parse memory limit to bytes
      const memBytes = this.parseMemoryLimit(memLimit);

      container = await docker.createContainer({
        name: containerName,
        Image: image,
        Cmd: cmd,
        WorkingDir: "/workspace",
        HostConfig: {
          Memory: memBytes,
          MemorySwap: memBytes, // No swap — hard memory ceiling
          NanoCpus: cpuLimit * 1e9,
          PidsLimit: 256, // Prevent fork bombs
          NetworkMode: "none", // Code exec has NO network access
          ReadonlyRootfs: true, // Immutable root filesystem
          CapDrop: ["ALL"], // Drop ALL Linux capabilities
          SecurityOpt: ["no-new-privileges:true"], // Prevent privilege escalation
          Tmpfs: {
            "/tmp": needsExecTmp
              ? "rw,nosuid,size=128m" // Compiled langs need exec in /tmp
              : "rw,noexec,nosuid,size=64m", // Scripting langs: no exec needed
          },
          Binds: [`${WORKSPACE_DIR}:/workspace`],
          AutoRemove: false,
        },
        Tty: false,
        OpenStdin: false,
      });

      await container.start();

      // Wait with timeout
      let timedOut = false;
      const waitPromise = container.wait();
      const timeoutPromise = new Promise<{ StatusCode: number }>((resolve) => {
        setTimeout(async () => {
          timedOut = true;
          try { await container!.kill(); } catch { }
          resolve({ StatusCode: 137 });
        }, timeout * 1000);
      });

      const result = await Promise.race([waitPromise, timeoutPromise]);

      // Get logs
      const logs = await container.logs({ stdout: true, stderr: true });
      const logStr = logs.toString("utf-8");

      // Separate stdout/stderr (Docker multiplexed stream)
      // Simple approach: treat all as combined output
      const stdout = logStr;
      const stderr = "";

      const durationMs = Date.now() - startTime;

      // Record analytics
      analyticsStore.record({
        eventType: "code_exec",
        durationMs,
        success: result.StatusCode === 0 && !timedOut,
        metadata: JSON.stringify({ language: containerName.includes("python") ? "python" : "other", exitCode: result.StatusCode }),
      });

      return {
        stdout: stdout.slice(0, 50000), // Cap output
        stderr: stderr.slice(0, 10000),
        exitCode: result.StatusCode,
        timedOut,
        durationMs,
      };
    } catch (err: any) {
      return {
        stdout: "",
        stderr: err.message,
        exitCode: 1,
        timedOut: false,
        durationMs: Date.now() - startTime,
      };
    } finally {
      // Cleanup
      if (container) {
        try { await container.remove({ force: true }); } catch { }
      }
    }
  }

  /**
   * Build and deploy a persistent app container
   */
  async deployApp(appId: number, dockerfile: string, buildContext: string, port: number, internalPort: number): Promise<{ containerId: string; port: number }> {
    if (!this.ready) throw new Error("Docker is not available");

    const app = appStore.getById(appId);
    if (!app) throw new Error("App not found");

    const imageName = `agent2077-app-${app.name.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
    const containerName = `agent2077-app-${appId}`;

    appStore.update(appId, { status: "building" });

    try {
      // Write Dockerfile
      const buildDir = path.join(WORKSPACE_DIR, "apps", `app-${appId}`);
      if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(path.join(buildDir, "Dockerfile"), dockerfile);

      // If buildContext is a different path from buildDir, copy entire source tree in.
      // Use cp -a (archive) so nested subdirectories, symlinks, and permissions are preserved.
      if (buildContext && fs.existsSync(buildContext)) {
        const resolvedCtx = path.resolve(buildContext);
        const resolvedBuild = path.resolve(buildDir);
        if (resolvedCtx !== resolvedBuild) {
          try {
            // Copy all contents of buildContext into buildDir (Dockerfile already written there)
            require("child_process").execSync(
              `cp -a ${JSON.stringify(resolvedCtx + "/")}. ${JSON.stringify(resolvedBuild + "/")}`,
              { stdio: "pipe" }
            );
            console.log(`[Docker] Copied build context from ${resolvedCtx} → ${resolvedBuild}`);
          } catch (cpErr: any) {
            console.warn(`[Docker] cp failed, falling back to rsync:`, cpErr.message);
            try {
              require("child_process").execSync(
                `rsync -a --exclude=node_modules --exclude=.git ${JSON.stringify(resolvedCtx + "/")} ${JSON.stringify(resolvedBuild + "/")}`,
                { stdio: "pipe" }
              );
            } catch {
              console.warn(`[Docker] rsync also failed — build may be missing source files`);
            }
          }
        }
        // If paths are the same, files are already in place — nothing to copy
      }

      // Build image — pipe a tar of the full build directory so nested
      // subdirectories (src/, public/, etc.) are included in the context.
      // Using execSync tar → readable stream avoids the dockerode src[] flat-list limitation.
      const { execSync } = require("child_process");
      const tarBuffer = execSync(`tar -C ${JSON.stringify(buildDir)} -cf - .`);
      const { Readable } = require("stream");
      const tarStream = Readable.from(tarBuffer);

      const stream = await docker.buildImage(tarStream, { t: imageName });

      await new Promise<void>((resolve, reject) => {
        docker.modem.followProgress(stream, (err: any) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Remove existing container if present (stop first if running)
      try {
        const existing = docker.getContainer(containerName);
        const info = await existing.inspect();
        // Stop if running, ignore errors (may already be stopped)
        if (info.State.Running) {
          await existing.stop().catch(() => {});
        }
        // Always force-remove the old container
        await existing.remove({ force: true });
        console.log(`[Docker] Removed existing container ${containerName}`);
      } catch (err: any) {
        // 404 = container doesn't exist, which is fine
        if (err.statusCode !== 404) {
          console.warn(`[Docker] Could not remove old container ${containerName}:`, err.message);
        }
      }

      // Create and start container
      const container = await docker.createContainer({
        name: containerName,
        Image: imageName,
        ExposedPorts: { [`${internalPort}/tcp`]: {} },
        HostConfig: {
          PortBindings: {
            [`${internalPort}/tcp`]: [{ HostPort: String(port) }],
          },
          RestartPolicy: { Name: "unless-stopped" },
        },
        Labels: {
          "agent2077.app": "true",
          "agent2077.appId": String(appId),
        },
      });

      await container.start();

      appStore.update(appId, {
        status: "running",
        containerId: container.id,
        imageName,
        port,
        lastStarted: new Date().toISOString(),
      });

      analyticsStore.record({
        eventType: "app_deploy",
        success: true,
        metadata: JSON.stringify({ appId, port, imageName }),
      });

      return { containerId: container.id, port };
    } catch (err: any) {
      appStore.update(appId, { status: "error", errorLog: err.message });
      throw err;
    }
  }

  /**
   * Start/stop/remove an app container
   */
  async startApp(appId: number) {
    const app = appStore.getById(appId);
    if (!app?.containerId) throw new Error("App has no container");
    const container = docker.getContainer(app.containerId);
    // Check if already running before calling start (avoids HTTP 304 "already started" error)
    try {
      const info = await container.inspect();
      if (info.State.Running) {
        console.log(`[Docker] Container for app ${appId} is already running — skipping start`);
        appStore.update(appId, { status: "running" });
        return;
      }
    } catch {
      // inspect failed — try starting anyway
    }
    await container.start();
    appStore.update(appId, { status: "running", lastStarted: new Date().toISOString() });
  }

  async stopApp(appId: number) {
    const app = appStore.getById(appId);
    if (!app?.containerId) throw new Error("App has no container");
    const container = docker.getContainer(app.containerId);
    await container.stop();
    appStore.update(appId, { status: "stopped", lastStopped: new Date().toISOString() });
  }

  async removeApp(appId: number) {
    const app = appStore.getById(appId);
    if (app?.containerId) {
      try {
        const container = docker.getContainer(app.containerId);
        await container.stop().catch(() => {});
        await container.remove({ force: true });
      } catch { }
    }
    // Remove image
    if (app?.imageName) {
      try { await docker.getImage(app.imageName).remove({ force: true }); } catch { }
    }
    // Remove build directory
    const buildDir = path.join(WORKSPACE_DIR, "apps", `app-${appId}`);
    if (fs.existsSync(buildDir)) {
      try { fs.rmSync(buildDir, { recursive: true, force: true }); } catch { }
    }
    appStore.delete(appId);
  }

  async getAppLogs(appId: number, tail: number = 100): Promise<string> {
    const app = appStore.getById(appId);
    if (!app?.containerId) return "No container found";
    try {
      const container = docker.getContainer(app.containerId);
      const logs = await container.logs({ stdout: true, stderr: true, tail });
      return logs.toString("utf-8");
    } catch (err: any) {
      return `Failed to get logs: ${err.message}`;
    }
  }

  async getContainerStats(): Promise<{ running: number; total: number }> {
    try {
      const containers = await docker.listContainers({ all: true, filters: { label: ["agent2077.app=true"] } });
      const running = containers.filter(c => c.State === "running").length;
      return { running, total: containers.length };
    } catch {
      return { running: 0, total: 0 };
    }
  }

  private parseMemoryLimit(limit: string): number {
    const match = limit.match(/^(\d+)(m|g)$/i);
    if (!match) return 512 * 1024 * 1024; // default 512MB
    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    return unit === "g" ? value * 1024 * 1024 * 1024 : value * 1024 * 1024;
  }
}

export const dockerManager = new DockerManager();
