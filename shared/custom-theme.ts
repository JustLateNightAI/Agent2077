/**
 * Custom theme helpers (v16.74.2)
 *
 * Pure, dependency-free utilities shared by the client (to apply the theme),
 * and the smoke test. The custom theme lets a user pick fonts and colours
 * which are persisted as a JSON string under the `theme.custom` settings key
 * and applied via CSS variables on the document root.
 *
 * Colours are validated/sanitised to hex and converted to the
 * "H S% L%" component form that the existing CSS variables use
 * (e.g. `--primary: 190 95% 50%`), so custom values plug straight into the
 * same token system as the built-in presets.
 */

export interface CustomThemeConfig {
  /** CSS font-family stack applied to body text. */
  fontFamily: string;
  /** Primary / brand colour (buttons, active states) — hex. */
  primary: string;
  /** Accent colour (highlights) — hex. */
  accent: string;
  /** Page background colour — hex. */
  background: string;
  /** Foreground / body text colour — hex. */
  foreground: string;
  /** Card / panel surface colour — hex. */
  card: string;
}

/** Built-in default custom config — a neutral dark slate w/ teal accent. */
export const DEFAULT_CUSTOM_THEME: CustomThemeConfig = {
  fontFamily: "Inter, system-ui, -apple-system, sans-serif",
  primary: "#00e5ff",
  accent: "#ff4fa3",
  background: "#0e1116",
  foreground: "#e6edf3",
  card: "#161b22",
};

/**
 * A conservative font-family validator. Allows letters, digits, spaces,
 * commas, hyphens, single/double quotes, parens and dots — enough for any
 * legitimate font stack (e.g. `"Space Grotesk", system-ui, sans-serif`) while
 * blocking characters that could break out of the CSS declaration (`;{}<>` etc).
 */
export function isValidFontFamily(font: string): boolean {
  if (typeof font !== "string") return false;
  const trimmed = font.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return false;
  return /^[A-Za-z0-9 ,._'"()\-]+$/.test(trimmed);
}

/** Normalise a font-family string, falling back to the default if invalid. */
export function sanitizeFontFamily(font: string): string {
  return isValidFontFamily(font) ? font.trim() : DEFAULT_CUSTOM_THEME.fontFamily;
}

/** True if `value` is a 3- or 6-digit hex colour (with leading #). */
export function isValidHexColor(value: string): boolean {
  if (typeof value !== "string") return false;
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim());
}

/** Expand #abc → #aabbcc and lower-case. Returns null if not a valid hex. */
export function normalizeHex(value: string): string | null {
  if (!isValidHexColor(value)) return null;
  let hex = value.trim().toLowerCase().slice(1);
  if (hex.length === 3) {
    hex = hex.split("").map((c) => c + c).join("");
  }
  return "#" + hex;
}

/**
 * Convert a hex colour to the `"H S% L%"` component string used by the CSS
 * variables (note: NO `hsl(...)` wrapper — Tailwind wraps these itself).
 * Returns null for invalid input.
 */
export function hexToHslComponents(value: string): string | null {
  const hex = normalizeHex(value);
  if (!hex) return null;
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }

  const H = Math.round(h * 360);
  const S = Math.round(s * 100);
  const L = Math.round(l * 100);
  return `${H} ${S}% ${L}%`;
}

/** Pick a readable foreground (black/white) for a given hex background. */
export function readableForeground(value: string): string {
  const hex = normalizeHex(value);
  if (!hex) return "0 0% 100%";
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Perceived luminance (sRGB-ish)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "0 0% 7%" : "0 0% 100%";
}

/**
 * Coerce an arbitrary (possibly partial / untrusted) object into a complete,
 * valid CustomThemeConfig. Invalid fields fall back to the default. This is the
 * single sanitisation entry point — call it before persisting or applying.
 */
export function sanitizeCustomTheme(input: unknown): CustomThemeConfig {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const pickColor = (key: keyof CustomThemeConfig): string => {
    const v = obj[key];
    const norm = typeof v === "string" ? normalizeHex(v) : null;
    return norm ?? DEFAULT_CUSTOM_THEME[key];
  };
  return {
    fontFamily: sanitizeFontFamily(typeof obj.fontFamily === "string" ? obj.fontFamily : ""),
    primary: pickColor("primary"),
    accent: pickColor("accent"),
    background: pickColor("background"),
    foreground: pickColor("foreground"),
    card: pickColor("card"),
  };
}

/** Parse the JSON string stored under `theme.custom`, with full sanitisation. */
export function parseCustomTheme(raw: string | null | undefined): CustomThemeConfig {
  if (!raw) return { ...DEFAULT_CUSTOM_THEME };
  try {
    return sanitizeCustomTheme(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_CUSTOM_THEME };
  }
}

/**
 * Build the map of CSS variable name → value for a sanitised custom config.
 * These are set as inline styles on the document root when the custom theme is
 * active, overriding the base `[data-theme="custom"]` block.
 */
export function customThemeCssVars(config: CustomThemeConfig): Record<string, string> {
  const bg = hexToHslComponents(config.background)!;
  const fg = hexToHslComponents(config.foreground)!;
  const card = hexToHslComponents(config.card)!;
  const primary = hexToHslComponents(config.primary)!;
  const accent = hexToHslComponents(config.accent)!;
  return {
    "--background": bg,
    "--foreground": fg,
    "--card": card,
    "--card-foreground": fg,
    "--popover": card,
    "--popover-foreground": fg,
    "--primary": primary,
    "--primary-foreground": readableForeground(config.primary),
    "--secondary": card,
    "--secondary-foreground": fg,
    "--muted": card,
    "--muted-foreground": fg,
    "--accent": accent,
    "--accent-foreground": readableForeground(config.accent),
    "--border": card,
    "--input": card,
    "--ring": primary,
    "--chart-1": primary,
    "--chart-2": accent,
    "--font-sans": config.fontFamily,
  };
}
