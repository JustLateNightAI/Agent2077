/**
 * Mask Generation Tools — Programmatic mask creation for inpainting.
 * Generates white-on-black masks that can be passed to inpaint_image.
 */
import { registerTool, type ToolResult } from "./registry.js";
import { settingsStore } from "../storage.js";
import sharp from "sharp";
import fs from "fs";
import path from "path";

const IMAGES_DIR = path.join(process.env.HOME || "/home/agent2077", "agent2077-images");

function ensureImagesDir(): void {
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
}

/**
 * Parse a region description into bounding box coordinates.
 * Supports: "center", "left", "right", "top", "bottom", "top-left", "top-right",
 * "bottom-left", "bottom-right", "left half", "right half", "top half", "bottom half",
 * "top third", "middle third", "bottom third", "full".
 * Also supports explicit coordinates: "x:100,y:100,w:200,h:200"
 */
function parseRegion(
  description: string,
  imageWidth: number,
  imageHeight: number
): { x: number; y: number; width: number; height: number } {
  const desc = description.toLowerCase().trim();

  // Explicit coordinates: "x:100,y:100,w:200,h:200"
  const coordMatch = desc.match(/x[:\s]*(\d+)[,\s]*y[:\s]*(\d+)[,\s]*w(?:idth)?[:\s]*(\d+)[,\s]*h(?:eight)?[:\s]*(\d+)/i);
  if (coordMatch) {
    return {
      x: parseInt(coordMatch[1]),
      y: parseInt(coordMatch[2]),
      width: parseInt(coordMatch[3]),
      height: parseInt(coordMatch[4]),
    };
  }

  // Percentage-based: "50%,30%,20%,20%" (x%, y%, w%, h%)
  const pctMatch = desc.match(/(\d+)%\s*,\s*(\d+)%\s*,\s*(\d+)%\s*,\s*(\d+)%/);
  if (pctMatch) {
    return {
      x: Math.round(imageWidth * parseInt(pctMatch[1]) / 100),
      y: Math.round(imageHeight * parseInt(pctMatch[2]) / 100),
      width: Math.round(imageWidth * parseInt(pctMatch[3]) / 100),
      height: Math.round(imageHeight * parseInt(pctMatch[4]) / 100),
    };
  }

  // Named regions
  const w = imageWidth;
  const h = imageHeight;
  const third = { w: Math.round(w / 3), h: Math.round(h / 3) };
  const half = { w: Math.round(w / 2), h: Math.round(h / 2) };
  const quarterW = Math.round(w / 4);
  const quarterH = Math.round(h / 4);

  // Center region (middle 50%)
  if (desc === "center" || desc === "middle" || desc === "center region") {
    return { x: quarterW, y: quarterH, width: half.w, height: half.h };
  }
  // Halves
  if (desc.includes("left half") || desc === "left") {
    return { x: 0, y: 0, width: half.w, height: h };
  }
  if (desc.includes("right half") || desc === "right") {
    return { x: half.w, y: 0, width: half.w, height: h };
  }
  if (desc.includes("top half") || desc === "top") {
    return { x: 0, y: 0, width: w, height: half.h };
  }
  if (desc.includes("bottom half") || desc === "bottom") {
    return { x: 0, y: half.h, width: w, height: half.h };
  }
  // Thirds
  if (desc.includes("top third")) {
    return { x: 0, y: 0, width: w, height: third.h };
  }
  if (desc.includes("middle third")) {
    return { x: 0, y: third.h, width: w, height: third.h };
  }
  if (desc.includes("bottom third")) {
    return { x: 0, y: third.h * 2, width: w, height: third.h };
  }
  if (desc.includes("left third")) {
    return { x: 0, y: 0, width: third.w, height: h };
  }
  if (desc.includes("center third") || desc.includes("middle column")) {
    return { x: third.w, y: 0, width: third.w, height: h };
  }
  if (desc.includes("right third")) {
    return { x: third.w * 2, y: 0, width: third.w, height: h };
  }
  // Corners
  if (desc.includes("top-left") || desc.includes("top left") || desc.includes("upper left")) {
    return { x: 0, y: 0, width: half.w, height: half.h };
  }
  if (desc.includes("top-right") || desc.includes("top right") || desc.includes("upper right")) {
    return { x: half.w, y: 0, width: half.w, height: half.h };
  }
  if (desc.includes("bottom-left") || desc.includes("bottom left") || desc.includes("lower left")) {
    return { x: 0, y: half.h, width: half.w, height: half.h };
  }
  if (desc.includes("bottom-right") || desc.includes("bottom right") || desc.includes("lower right")) {
    return { x: half.w, y: half.h, width: half.w, height: half.h };
  }
  // Full image
  if (desc === "full" || desc === "entire" || desc === "all" || desc === "whole") {
    return { x: 0, y: 0, width: w, height: h };
  }

  // Default: center 40% of the image
  const margin = 0.3;
  return {
    x: Math.round(w * margin),
    y: Math.round(h * margin),
    width: Math.round(w * (1 - 2 * margin)),
    height: Math.round(h * (1 - 2 * margin)),
  };
}

// ── create_inpaint_mask ─────────────────────────────────────────────

registerTool("create_inpaint_mask", {
  category: "image",
  requiresApproval: false,
  definition: {
    type: "function",
    function: {
      name: "create_inpaint_mask",
      description:
        "Create an inpainting mask for a specific region of an image. " +
        "The mask is white in the area to be regenerated and black elsewhere. " +
        "Use this before calling inpaint_image when you need to edit a specific part of an image. " +
        "You can specify the region as named areas (e.g., 'center', 'left half', 'top-right'), " +
        "exact pixel coordinates (e.g., 'x:100,y:100,w:200,h:200'), " +
        "or percentage-based (e.g., '25%,25%,50%,50%' for x%,y%,w%,h%). " +
        "For best results when the user describes an object to edit (like 'the apple'), " +
        "estimate the object's approximate position and size in the image.",
      parameters: {
        type: "object",
        required: ["sourceImagePath", "region"],
        properties: {
          sourceImagePath: {
            type: "string",
            description: "Absolute path to the source image (to match its dimensions).",
          },
          region: {
            type: "string",
            description:
              "Region to mask. Can be: named region ('center', 'left half', 'top-right', 'bottom third'), " +
              "pixel coordinates ('x:100,y:100,w:200,h:200'), " +
              "or percentages ('25%,25%,50%,50%' for x%,y%,w%,h%).",
          },
          feather: {
            type: "number",
            description: "Feather/blur radius in pixels for soft edges (default 0 = hard edges, try 10-30 for softer blending).",
          },
          invert: {
            type: "boolean",
            description: "If true, inverts the mask (black region becomes white, vice versa). Default false.",
          },
          shape: {
            type: "string",
            description: "Shape of the mask region: 'rectangle' (default) or 'ellipse'.",
          },
        },
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    try {
      const sourceImagePath = args.sourceImagePath as string;
      if (!fs.existsSync(sourceImagePath)) {
        return { success: false, output: `Source image not found: ${sourceImagePath}` };
      }

      // Get image dimensions
      const metadata = await sharp(sourceImagePath).metadata();
      const imgWidth = metadata.width!;
      const imgHeight = metadata.height!;

      // Parse region
      const region = parseRegion(args.region as string, imgWidth, imgHeight);

      // Clamp to image bounds
      region.x = Math.max(0, Math.min(region.x, imgWidth - 1));
      region.y = Math.max(0, Math.min(region.y, imgHeight - 1));
      region.width = Math.min(region.width, imgWidth - region.x);
      region.height = Math.min(region.height, imgHeight - region.y);

      const shape = (args.shape as string)?.toLowerCase() || "rectangle";
      const feather = (args.feather as number) || 0;
      const invert = (args.invert as boolean) || false;

      // Create the mask: black background, white region
      let maskBuffer: Buffer;

      if (shape === "ellipse") {
        // Create SVG with ellipse for the mask
        const cx = region.x + region.width / 2;
        const cy = region.y + region.height / 2;
        const rx = region.width / 2;
        const ry = region.height / 2;
        const svg = `<svg width="${imgWidth}" height="${imgHeight}" xmlns="http://www.w3.org/2000/svg">
          <rect width="100%" height="100%" fill="${invert ? 'white' : 'black'}"/>
          <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${invert ? 'black' : 'white'}"/>
        </svg>`;
        maskBuffer = await sharp(Buffer.from(svg))
          .png()
          .toBuffer();
      } else {
        // Rectangle mask
        const svg = `<svg width="${imgWidth}" height="${imgHeight}" xmlns="http://www.w3.org/2000/svg">
          <rect width="100%" height="100%" fill="${invert ? 'white' : 'black'}"/>
          <rect x="${region.x}" y="${region.y}" width="${region.width}" height="${region.height}" fill="${invert ? 'black' : 'white'}"/>
        </svg>`;
        maskBuffer = await sharp(Buffer.from(svg))
          .png()
          .toBuffer();
      }

      // Apply feathering (gaussian blur) if requested
      if (feather > 0) {
        // Blur to create soft edges, then re-threshold to maintain mostly binary mask
        maskBuffer = await sharp(maskBuffer)
          .blur(feather)
          .png()
          .toBuffer();
      }

      // Save the mask
      ensureImagesDir();
      const timestamp = Date.now();
      const maskFilename = `mask_${timestamp}.png`;
      const maskPath = path.join(IMAGES_DIR, maskFilename);
      await sharp(maskBuffer).toFile(maskPath);

      return {
        success: true,
        output: `Mask created: ${maskPath}\n` +
          `Image dimensions: ${imgWidth}×${imgHeight}\n` +
          `Masked region: x=${region.x}, y=${region.y}, w=${region.width}, h=${region.height}\n` +
          `Shape: ${shape}${feather > 0 ? `, feather=${feather}px` : ""}${invert ? ", inverted" : ""}\n` +
          `\nYou can now use this mask with inpaint_image:\n` +
          `  inpaint_image(sourceImagePath="${sourceImagePath}", maskImagePath="${maskPath}", prompt="...")`,
        metadata: { maskPath, region, imgWidth, imgHeight },
      };
    } catch (e: any) {
      return { success: false, output: `create_inpaint_mask error: ${e.message}` };
    }
  },
});
