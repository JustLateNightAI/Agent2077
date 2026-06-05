/**
 * Custom theme helper smoke tests (v16.74.2):
 *  - hex validation accepts 3/6-digit, rejects garbage
 *  - font validation rejects CSS-breaking characters
 *  - hex → HSL component conversion (known colours)
 *  - sanitizeCustomTheme coerces partial / malicious input to a safe config
 *  - parseCustomTheme round-trips JSON and falls back on bad input
 *  - customThemeCssVars produces all expected variables w/ no `hsl(` wrapper
 *
 * Pure functions only — no DB. Run with: npx tsx script/test-custom-theme.ts
 */
import {
  isValidHexColor,
  isValidFontFamily,
  normalizeHex,
  hexToHslComponents,
  sanitizeCustomTheme,
  parseCustomTheme,
  customThemeCssVars,
  DEFAULT_CUSTOM_THEME,
} from "../shared/custom-theme.js";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${label}${detail ? " — " + detail : ""}`);
  if (!ok) { failures++; process.exitCode = 1; }
}

// ── Hex validation ──────────────────────────────────────────────────
check("valid 6-digit hex", isValidHexColor("#1a2b3c"));
check("valid 3-digit hex", isValidHexColor("#abc"));
check("reject missing #", !isValidHexColor("1a2b3c"));
check("reject bad length", !isValidHexColor("#12345"));
check("reject non-hex chars", !isValidHexColor("#gggggg"));
check("reject injection", !isValidHexColor("#000;}body{display:none"));

// ── Font validation ─────────────────────────────────────────────────
check("valid font stack", isValidFontFamily("'Space Grotesk', system-ui, sans-serif"));
check("valid simple font", isValidFontFamily("Inter"));
check("reject semicolon", !isValidFontFamily("Inter; } body { color: red"));
check("reject braces", !isValidFontFamily("Inter{}"));
check("reject empty", !isValidFontFamily("  "));
check("reject overlong", !isValidFontFamily("a".repeat(201)));

// ── normalizeHex ────────────────────────────────────────────────────
check("expand 3-digit", normalizeHex("#ABC") === "#aabbcc");
check("lowercase 6-digit", normalizeHex("#FF00AA") === "#ff00aa");
check("normalize null on bad", normalizeHex("nope") === null);

// ── hexToHslComponents (known values) ───────────────────────────────
check("black → 0 0% 0%", hexToHslComponents("#000000") === "0 0% 0%");
check("white → 0 0% 100%", hexToHslComponents("#ffffff") === "0 0% 100%");
check("red → 0 100% 50%", hexToHslComponents("#ff0000") === "0 100% 50%");
{
  const lime = hexToHslComponents("#00ff00");
  check("lime → 120 100% 50%", lime === "120 100% 50%", lime ?? "null");
}
check("hsl bad input → null", hexToHslComponents("zzz") === null);

// ── sanitizeCustomTheme ─────────────────────────────────────────────
{
  const clean = sanitizeCustomTheme({
    fontFamily: "Inter; }malicious",
    primary: "#fff",
    accent: "not-a-color",
    background: "#0e1116",
    foreground: "#e6edf3",
    card: "#161b22",
  });
  check("bad font falls back", clean.fontFamily === DEFAULT_CUSTOM_THEME.fontFamily);
  check("valid 3-digit expanded", clean.primary === "#ffffff");
  check("bad color falls back", clean.accent === DEFAULT_CUSTOM_THEME.accent);
  check("valid color kept", clean.background === "#0e1116");
}
{
  const fromGarbage = sanitizeCustomTheme("totally not an object" as unknown);
  check("non-object → defaults", fromGarbage.primary === DEFAULT_CUSTOM_THEME.primary);
}

// ── parseCustomTheme ────────────────────────────────────────────────
check("null → defaults", parseCustomTheme(null).primary === DEFAULT_CUSTOM_THEME.primary);
check("malformed JSON → defaults", parseCustomTheme("{not json").card === DEFAULT_CUSTOM_THEME.card);
{
  const json = JSON.stringify({ ...DEFAULT_CUSTOM_THEME, primary: "#123456" });
  check("round-trip JSON", parseCustomTheme(json).primary === "#123456");
}

// ── customThemeCssVars ──────────────────────────────────────────────
{
  const vars = customThemeCssVars(DEFAULT_CUSTOM_THEME);
  const required = [
    "--background", "--foreground", "--card", "--primary",
    "--primary-foreground", "--accent", "--ring", "--font-sans",
  ];
  const hasAll = required.every((k) => k in vars);
  check("all required CSS vars present", hasAll);
  const noHslWrapper = Object.entries(vars)
    .filter(([k]) => k !== "--font-sans")
    .every(([, v]) => !v.includes("hsl("));
  check("color vars are component form (no hsl wrapper)", noHslWrapper);
  check("font var matches config", vars["--font-sans"] === DEFAULT_CUSTOM_THEME.fontFamily);
}

console.log(failures === 0 ? "\nAll custom-theme tests passed." : `\n${failures} test(s) failed.`);
