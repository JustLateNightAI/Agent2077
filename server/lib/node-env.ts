/**
 * node-env.ts — Shared utility for resolving a PATH that includes node/npm/npx.
 *
 * When Agent2077 runs as a service, the spawned shells do not inherit the
 * user's nvm/fnm PATH. This helper scans well-known locations at call-time
 * and returns a process env object safe to spread into execSync / spawn options.
 */
import fs from "fs";
import path from "path";
import os from "os";

export function resolveNodeEnv(): NodeJS.ProcessEnv {
  const extraPaths: string[] = [];
  const home = process.env.HOME || os.homedir();

  // 1. nvm default alias (most reliable)
  const nvmVersionsDir = path.join(home, ".nvm", "versions", "node");
  const nvmDefaultFile = path.join(home, ".nvm", "alias", "default");
  if (fs.existsSync(nvmDefaultFile)) {
    try {
      const alias = fs.readFileSync(nvmDefaultFile, "utf-8").trim();
      // alias may be a version like "v20.11.0" or a named alias like "lts/*"
      // try it directly first, then scan versions dir for a prefix match
      const direct = path.join(nvmVersionsDir, alias, "bin");
      if (fs.existsSync(direct)) {
        extraPaths.push(direct);
      } else if (fs.existsSync(nvmVersionsDir)) {
        const versions = fs.readdirSync(nvmVersionsDir).sort().reverse();
        for (const v of versions) {
          const binDir = path.join(nvmVersionsDir, v, "bin");
          if (fs.existsSync(binDir)) { extraPaths.push(binDir); break; }
        }
      }
    } catch { /* ignore */ }
  } else if (fs.existsSync(nvmVersionsDir)) {
    // No default alias — just pick the newest version
    try {
      const versions = fs.readdirSync(nvmVersionsDir).sort().reverse();
      for (const v of versions) {
        const binDir = path.join(nvmVersionsDir, v, "bin");
        if (fs.existsSync(binDir)) { extraPaths.push(binDir); break; }
      }
    } catch { /* ignore */ }
  }

  // 2. fnm
  const fnmDir = path.join(home, ".local", "share", "fnm", "node-versions");
  if (fs.existsSync(fnmDir)) {
    try {
      const versions = fs.readdirSync(fnmDir).sort().reverse();
      for (const v of versions) {
        const binDir = path.join(fnmDir, v, "installation", "bin");
        if (fs.existsSync(binDir)) { extraPaths.push(binDir); break; }
      }
    } catch { /* ignore */ }
  }

  // 3. volta
  const voltaBin = path.join(home, ".volta", "bin");
  if (fs.existsSync(voltaBin)) extraPaths.push(voltaBin);

  // 4. Standard system paths (as fallback)
  for (const p of ["/usr/local/bin", "/usr/bin", "/usr/local/lib/nodejs/bin", "/opt/node/bin", "/snap/bin"]) {
    if (fs.existsSync(p) && !extraPaths.includes(p)) extraPaths.push(p);
  }

  const basePath = process.env.PATH || "";
  const resolvedPath = [...extraPaths, basePath].filter(Boolean).join(":");

  return { ...process.env, PATH: resolvedPath, HOME: home };
}

/**
 * Find the absolute path to a binary (node, npx, npm) using the resolved PATH.
 * Returns the binary name as-is if not found (shell will handle it).
 */
export function resolveBin(bin: string): string {
  const env = resolveNodeEnv();
  for (const dir of (env.PATH || "").split(":")) {
    const candidate = path.join(dir, bin);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* keep looking */ }
  }
  return bin; // fallback — let shell resolve it
}
