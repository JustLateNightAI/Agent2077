/**
 * TLS Certificate Manager
 *
 * Generates a self-signed certificate on first run using the system's OpenSSL
 * (guaranteed available on Ubuntu/Linux). Certs are stored in data/tls/ and
 * reused across restarts.
 *
 * This provides basic encryption for LAN traffic — prevents passive sniffing.
 * Users will see a browser "untrusted certificate" warning which they can accept
 * once (or add to their trusted store using the instructions logged at startup).
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";

// Resolve agent root relative to the running process — works in both ESM and
// CJS (esbuild bundles to CJS, so import.meta.url is undefined at runtime).
// process.cwd() is always the directory you launch from, which for Agent2077
// is always the project root (where package.json lives).
const AGENT_ROOT = process.cwd();
const TLS_DIR = path.join(AGENT_ROOT, "data", "tls");
const KEY_FILE = path.join(TLS_DIR, "server.key");
const CERT_FILE = path.join(TLS_DIR, "server.crt");

export interface TlsCerts {
  key: Buffer;
  cert: Buffer;
}

/**
 * Returns true if HTTPS should be used.
 * Reads the TLS_ENABLED env var (overrides settings) or the network.httpsEnabled setting.
 */
export function isTlsEnabled(settingsStore: { get: (k: string) => string | null }): boolean {
  // Env var takes precedence — useful for disabling in dev
  if (process.env.TLS_ENABLED === "false") return false;
  if (process.env.TLS_ENABLED === "true") return true;
  // Fall back to settings
  const val = settingsStore.get("network.httpsEnabled");
  return val === "true";
}

/**
 * Ensure TLS cert and key exist, generating them if necessary.
 * Returns { key, cert } buffers ready for https.createServer().
 */
export function ensureCerts(): TlsCerts {
  fs.mkdirSync(TLS_DIR, { recursive: true });

  if (!fs.existsSync(KEY_FILE) || !fs.existsSync(CERT_FILE)) {
    console.log("[TLS] Generating self-signed certificate...");
    try {
      // Generate private key
      execSync(`openssl genrsa -out "${KEY_FILE}" 2048`, { stdio: "pipe" });

      // Create a minimal OpenSSL config for the cert with SAN
      const confPath = path.join(TLS_DIR, "san.conf");
      fs.writeFileSync(confPath, [
        "[req]",
        "distinguished_name = req_distinguished_name",
        "x509_extensions = v3_req",
        "prompt = no",
        "[req_distinguished_name]",
        "C = US",
        "O = Agent2077 Local",
        "CN = agent2077.local",
        "[v3_req]",
        "keyUsage = keyEncipherment, dataEncipherment",
        "extendedKeyUsage = serverAuth",
        "subjectAltName = @alt_names",
        "[alt_names]",
        "DNS.1 = localhost",
        "DNS.2 = agent2077.local",
        "DNS.3 = devagent.local",
        "IP.1 = 127.0.0.1",
        "IP.2 = 0.0.0.0",
      ].join("\n"), "utf-8");

      // Generate self-signed cert (valid 10 years)
      execSync(
        `openssl req -new -x509 -key "${KEY_FILE}" -out "${CERT_FILE}" -days 3650 -config "${confPath}"`,
        { stdio: "pipe" }
      );

      // Set restrictive permissions on the key
      fs.chmodSync(KEY_FILE, 0o600);
      fs.chmodSync(CERT_FILE, 0o644);

      console.log("[TLS] Self-signed certificate generated:");
      console.log(`  Key:  ${KEY_FILE}`);
      console.log(`  Cert: ${CERT_FILE}`);
      console.log("[TLS] To trust this cert in your browser, visit the HTTPS URL");
      console.log("       and accept the security exception (or import the cert to your OS trust store).");
      console.log(`[TLS] To add to Ubuntu trust store:`);
      console.log(`       sudo cp "${CERT_FILE}" /usr/local/share/ca-certificates/agent2077.crt`);
      console.log(`       sudo update-ca-certificates`);
    } catch (err: any) {
      console.error("[TLS] Failed to generate certificate:", err.message);
      throw new Error(`TLS certificate generation failed: ${err.message}`);
    }
  } else {
    console.log("[TLS] Using existing certificate from", TLS_DIR);
  }

  return {
    key: fs.readFileSync(KEY_FILE),
    cert: fs.readFileSync(CERT_FILE),
  };
}
