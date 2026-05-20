/**
 * Image Tools — ComfyUI integration for Agent2077.
 * Provides text-to-image, img2img, inpainting, upscaling, ControlNet,
 * background removal, face restoration, workflow management, and queue control.
 */
import { registerTool, type ToolResult } from "./registry.js";
import { settingsStore, generatedImageStore } from "../storage.js";
import {
  checkConnection,
  listModels,
  generateAndSave,
  uploadImage,
  uploadMask,
  validateWorkflow,
  getQueue,
  interrupt,
  getObjectInfo,
  IMAGES_DIR,
} from "../lib/comfyui-client.js";
import {
  WORKFLOW_TEMPLATES,
  WorkflowBuilder,
  buildTxt2Img,
  img2imgTemplate,
  upscaleTemplate,
  inpaintTemplate,
  controlnetTemplate,
} from "../lib/comfyui-workflows.js";
import fs from "fs";
import path from "path";

// ── Helpers ───────────────────────────────────────────────────────────

function requireComfyUI(): string | null {
  const host = settingsStore.get("comfyuiHost");
  if (!host) return "ComfyUI is not configured. Set the ComfyUI endpoint in Settings.";
  return null;
}

/**
 * Resolve a checkpoint name against the actual ComfyUI model list.
 * ComfyUI requires exact names like "2_5D/calmformSDXL_v10.safetensors".
 * The AI may pass partial names like "calmformSDXL_v10" — this fuzzy-matches.
 * Returns { checkpoint, allCheckpoints } or { error }.
 */
async function resolveCheckpoint(requested?: string): Promise<{
  checkpoint?: string;
  allCheckpoints: string[];
  error?: string;
}> {
  const models = await listModels();
  const allCheckpoints = models.checkpoints;
  if (allCheckpoints.length === 0) {
    return { allCheckpoints, error: "No checkpoint models found in ComfyUI. Install at least one checkpoint model." };
  }

  // If none requested, use first available
  if (!requested) {
    return { checkpoint: allCheckpoints[0], allCheckpoints };
  }

  // Exact match
  if (allCheckpoints.includes(requested)) {
    return { checkpoint: requested, allCheckpoints };
  }

  // Fuzzy match: strip path & extension from both sides and compare
  const normalize = (s: string) => s.replace(/.*\//, "").replace(/\.(safetensors|ckpt|pt|bin)$/i, "").toLowerCase();
  const reqNorm = normalize(requested);

  // Try exact normalized match
  const exact = allCheckpoints.find(c => normalize(c) === reqNorm);
  if (exact) return { checkpoint: exact, allCheckpoints };

  // Try partial match (requested is substring of actual, or vice versa)
  const partial = allCheckpoints.find(c => normalize(c).includes(reqNorm) || reqNorm.includes(normalize(c)));
  if (partial) return { checkpoint: partial, allCheckpoints };

  // No match found — return error with available list
  const available = allCheckpoints.slice(0, 20).join("\n  ");
  return {
    allCheckpoints,
    error: `Checkpoint "${requested}" not found. Available checkpoints (${allCheckpoints.length}):\n  ${available}${
      allCheckpoints.length > 20 ? `\n  ... and ${allCheckpoints.length - 20} more` : ""
    }\nUse list_comfyui_models to see the full list, then retry with an exact checkpoint name.`,
  };
}

// ── 1. generate_image ─────────────────────────────────────────────────

registerTool("generate_image", {
  category: "image",
  requiresApproval: false,
  checkFn: () => !!settingsStore.get("comfyuiHost"),
  definition: {
    type: "function",
    function: {
      name: "generate_image",
      description:
        "Generate one or more images from a text prompt using a ComfyUI checkpoint model. " +
        "Returns the local file paths of all generated images. " +
        "If no checkpoint is specified, the first available model is used. " +
        "Checkpoint names are fuzzy-matched, but for best results call list_comfyui_models first to get exact names.",
      parameters: {
        type: "object",
        required: ["prompt"],
        properties: {
          prompt: { type: "string", description: "Positive text prompt describing the desired image." },
          negativePrompt: { type: "string", description: "Negative prompt listing things to avoid." },
          checkpoint: { type: "string", description: "Checkpoint model filename (e.g. 'v1-5-pruned.ckpt'). Uses default if omitted." },
          width: { type: "number", description: "Image width in pixels (default 1024)." },
          height: { type: "number", description: "Image height in pixels (default 1024)." },
          steps: { type: "number", description: "Number of sampling steps (default 20)." },
          cfg: { type: "number", description: "CFG scale / guidance strength (default 7)." },
          sampler: { type: "string", description: "Sampler name, e.g. 'euler', 'dpm_2', 'dpmpp_2m' (default 'euler')." },
          scheduler: { type: "string", description: "Scheduler name, e.g. 'normal', 'karras' (default 'normal')." },
          seed: { type: "number", description: "Seed for reproducibility (-1 = random)." },
          batchSize: { type: "number", description: "Number of images to generate in one pass (default 1, max 8)." },
          lora: {
            type: "object",
            description: "Optional LoRA to apply.",
            properties: {
              name: { type: "string", description: "LoRA filename." },
              strength: { type: "number", description: "LoRA strength (default 1.0)." },
            },
          },
        },
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const err = requireComfyUI();
    if (err) return { success: false, output: err };

    try {
      // Resolve checkpoint with fuzzy matching against actual ComfyUI model list
      const ckptResult = await resolveCheckpoint(args.checkpoint as string | undefined);
      if (ckptResult.error) return { success: false, output: ckptResult.error };
      const checkpoint = ckptResult.checkpoint!;

      const workflow = buildTxt2Img({
        prompt: args.prompt,
        negativePrompt: args.negativePrompt,
        checkpoint,
        width: args.width,
        height: args.height,
        steps: args.steps,
        cfg: args.cfg,
        sampler: args.sampler,
        scheduler: args.scheduler,
        seed: args.seed ?? -1,
        batchSize: args.batchSize,
        lora: args.lora ? { name: args.lora.name, strengthModel: args.lora.strength, strengthClip: args.lora.strength } : undefined,
      });

      const result = await generateAndSave(workflow);

      if (!result.success) {
        return { success: false, output: `Generation failed: ${result.error}` };
      }

      // Save each generated image to DB for gallery/metadata tracking
      for (const fp of result.filePaths) {
        try {
          generatedImageStore.create({
            filePath: fp,
            prompt: args.prompt as string,
            negativePrompt: (args.negativePrompt as string) || null,
            model: checkpoint!,
            width: (args.width as number) ?? 1024,
            height: (args.height as number) ?? 1024,
            steps: (args.steps as number) ?? 20,
            cfg: (args.cfg as number) ?? 7,
            sampler: (args.sampler as string) ?? "euler",
            scheduler: (args.scheduler as string) ?? "normal",
            seed: (args.seed as number) ?? -1,
            generationType: "txt2img",
            conversationId: (args._conversationId as number) ?? null,
            durationMs: result.durationMs,
            comfyuiPromptId: result.promptId,
          });
        } catch (_) { /* non-critical — don't fail generation if DB save fails */ }
      }

      const summary = [
        `Generated ${result.filePaths.length} image(s) in ${(result.durationMs / 1000).toFixed(1)}s.`,
        `Model: ${checkpoint}`,
        `Prompt ID: ${result.promptId}`,
        `Files:\n${result.filePaths.map(p => `  ${p}`).join("\n")}`,
      ].join("\n");

      return {
        success: true,
        output: summary,
        metadata: { filePaths: result.filePaths, promptId: result.promptId, durationMs: result.durationMs, model: checkpoint },
      };
    } catch (e: any) {
      return { success: false, output: `generate_image error: ${e.message}` };
    }
  },
});

// ── 2. image_to_image ─────────────────────────────────────────────────

registerTool("image_to_image", {
  category: "image",
  requiresApproval: false,
  checkFn: () => !!settingsStore.get("comfyuiHost"),
  definition: {
    type: "function",
    function: {
      name: "image_to_image",
      description: "Transform an existing image using a text prompt (img2img). " +
        "Uploads the source image to ComfyUI and returns the transformed image file paths.",
      parameters: {
        type: "object",
        required: ["sourceImagePath", "prompt"],
        properties: {
          sourceImagePath: { type: "string", description: "Absolute path to the source image on disk." },
          prompt: { type: "string", description: "Positive text prompt describing the desired transformation." },
          checkpoint: { type: "string", description: "Checkpoint model filename. Uses first available if omitted." },
          denoise: { type: "number", description: "Denoise strength 0.0 (keep original) to 1.0 (full redraw). Default 0.7." },
          steps: { type: "number", description: "Sampling steps (default 20)." },
          cfg: { type: "number", description: "CFG scale (default 7)." },
          sampler: { type: "string", description: "Sampler name (default 'euler')." },
          seed: { type: "number", description: "Seed (-1 = random)." },
        },
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const err = requireComfyUI();
    if (err) return { success: false, output: err };

    try {
      if (!fs.existsSync(args.sourceImagePath)) {
        return { success: false, output: `Source image not found: ${args.sourceImagePath}` };
      }

      const ckptResult = await resolveCheckpoint(args.checkpoint as string | undefined);
      if (ckptResult.error) return { success: false, output: ckptResult.error };
      const checkpoint = ckptResult.checkpoint!;

      // Upload to ComfyUI input folder
      const uploadResult = await uploadImage(args.sourceImagePath);
      const inputImageName = uploadResult.name;

      const workflow = img2imgTemplate.build({
        prompt: args.prompt,
        checkpoint,
        inputImage: inputImageName,
        denoise: args.denoise ?? 0.7,
        steps: args.steps,
        cfg: args.cfg,
        sampler: args.sampler,
        seed: args.seed ?? -1,
      });

      const result = await generateAndSave(workflow);
      if (!result.success) return { success: false, output: `img2img failed: ${result.error}` };

      for (const fp of result.filePaths) {
        try {
          generatedImageStore.create({
            filePath: fp,
            prompt: args.prompt as string,
            model: checkpoint!,
            steps: (args.steps as number) ?? 20,
            cfg: (args.cfg as number) ?? 7,
            sampler: (args.sampler as string) ?? "euler",
            seed: (args.seed as number) ?? -1,
            generationType: "img2img",
            conversationId: (args._conversationId as number) ?? null,
            durationMs: result.durationMs,
            comfyuiPromptId: result.promptId,
          });
        } catch (_) {}
      }

      return {
        success: true,
        output: `img2img complete in ${(result.durationMs / 1000).toFixed(1)}s.\nModel: ${checkpoint}\nFiles:\n${result.filePaths.map(p => `  ${p}`).join("\n")}`,
        metadata: { filePaths: result.filePaths, promptId: result.promptId, model: checkpoint },
      };
    } catch (e: any) {
      return { success: false, output: `image_to_image error: ${e.message}` };
    }
  },
});

// ── 3. inpaint_image ──────────────────────────────────────────────────

registerTool("inpaint_image", {
  category: "image",
  requiresApproval: false,
  checkFn: () => !!settingsStore.get("comfyuiHost"),
  definition: {
    type: "function",
    function: {
      name: "inpaint_image",
      description: "Inpaint a masked region of an image — use this when the user wants to edit, remove, or change a specific part of an existing image. " +
        "The mask should be white in areas to regenerate and black elsewhere. " +
        "If the user doesn't provide a mask, you can generate one programmatically or direct them to the Image Gallery's inpaint editor.",
      parameters: {
        type: "object",
        required: ["sourceImagePath", "maskImagePath", "prompt"],
        properties: {
          sourceImagePath: { type: "string", description: "Absolute path to the source image." },
          maskImagePath: { type: "string", description: "Absolute path to the mask image (white = inpaint region)." },
          prompt: { type: "string", description: "Positive prompt for what to generate in the masked area." },
          checkpoint: { type: "string", description: "Checkpoint model filename. Uses first available if omitted." },
          denoise: { type: "number", description: "Denoise strength (default 0.8)." },
          steps: { type: "number", description: "Sampling steps (default 20)." },
          cfg: { type: "number", description: "CFG scale (default 7)." },
          seed: { type: "number", description: "Seed (-1 = random)." },
        },
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const err = requireComfyUI();
    if (err) return { success: false, output: err };

    try {
      if (!fs.existsSync(args.sourceImagePath)) {
        return { success: false, output: `Source image not found: ${args.sourceImagePath}` };
      }
      if (!fs.existsSync(args.maskImagePath)) {
        return { success: false, output: `Mask image not found: ${args.maskImagePath}` };
      }

      const ckptResult = await resolveCheckpoint(args.checkpoint as string | undefined);
      if (ckptResult.error) return { success: false, output: ckptResult.error };
      const checkpoint = ckptResult.checkpoint!;

      const [imgUpload, maskUpload] = await Promise.all([
        uploadImage(args.sourceImagePath),
        uploadMask(args.maskImagePath),
      ]);

      const workflow = inpaintTemplate.build({
        prompt: args.prompt,
        checkpoint,
        inputImage: imgUpload.name,
        maskImage: maskUpload.name,
        denoise: args.denoise ?? 0.8,
        steps: args.steps,
        cfg: args.cfg,
        seed: args.seed ?? -1,
      });

      const result = await generateAndSave(workflow);
      if (!result.success) return { success: false, output: `Inpainting failed: ${result.error}` };

      for (const fp of result.filePaths) {
        try {
          generatedImageStore.create({
            filePath: fp,
            prompt: args.prompt as string,
            model: checkpoint!,
            steps: (args.steps as number) ?? 20,
            cfg: (args.cfg as number) ?? 7,
            seed: (args.seed as number) ?? -1,
            generationType: "inpaint",
            conversationId: (args._conversationId as number) ?? null,
            durationMs: result.durationMs,
            comfyuiPromptId: result.promptId,
          });
        } catch (_) {}
      }

      return {
        success: true,
        output: `Inpainting complete in ${(result.durationMs / 1000).toFixed(1)}s.\nModel: ${checkpoint}\nFiles:\n${result.filePaths.map(p => `  ${p}`).join("\n")}`,
        metadata: { filePaths: result.filePaths, promptId: result.promptId, model: checkpoint },
      };
    } catch (e: any) {
      return { success: false, output: `inpaint_image error: ${e.message}` };
    }
  },
});

// ── 4. controlnet_generate ────────────────────────────────────────────

registerTool("controlnet_generate", {
  category: "image",
  requiresApproval: false,
  checkFn: () => !!settingsStore.get("comfyuiHost"),
  definition: {
    type: "function",
    function: {
      name: "controlnet_generate",
      description: "Generate an image guided by a ControlNet control image (canny edge, depth map, pose skeleton, etc.).",
      parameters: {
        type: "object",
        required: ["controlImagePath", "prompt"],
        properties: {
          controlImagePath: { type: "string", description: "Absolute path to the control image." },
          controlType: {
            type: "string",
            description: "Type of control image: 'canny', 'depth', or 'pose'.",
            enum: ["canny", "depth", "pose"],
          },
          prompt: { type: "string", description: "Positive prompt." },
          checkpoint: { type: "string", description: "Checkpoint model filename." },
          controlnetModel: { type: "string", description: "ControlNet model filename. Auto-selected from installed models if omitted." },
          strength: { type: "number", description: "ControlNet strength 0.0–1.0 (default 1.0)." },
          width: { type: "number", description: "Output width (default 1024)." },
          height: { type: "number", description: "Output height (default 1024)." },
          steps: { type: "number", description: "Sampling steps (default 20)." },
          cfg: { type: "number", description: "CFG scale (default 7)." },
          seed: { type: "number", description: "Seed (-1 = random)." },
        },
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const err = requireComfyUI();
    if (err) return { success: false, output: err };

    try {
      if (!fs.existsSync(args.controlImagePath)) {
        return { success: false, output: `Control image not found: ${args.controlImagePath}` };
      }

      const ckptResult = await resolveCheckpoint(args.checkpoint as string | undefined);
      if (ckptResult.error) return { success: false, output: ckptResult.error };
      const checkpoint = ckptResult.checkpoint!;

      const models = await listModels();
      let controlnetModel = args.controlnetModel as string | undefined;
      if (!controlnetModel) {
        if (models.controlnet.length === 0) {
          return { success: false, output: "No ControlNet models installed. Download a ControlNet model first." };
        }
        // Try to find a matching model by control type
        const controlType = (args.controlType as string || "canny").toLowerCase();
        const match = models.controlnet.find(m => m.toLowerCase().includes(controlType));
        controlnetModel = match || models.controlnet[0];
      }

      const imgUpload = await uploadImage(args.controlImagePath);

      const workflow = controlnetTemplate.build({
        prompt: args.prompt,
        checkpoint,
        controlnetModel,
        controlImage: imgUpload.name,
        strength: args.strength ?? 1.0,
        width: args.width,
        height: args.height,
        steps: args.steps,
        cfg: args.cfg,
        seed: args.seed ?? -1,
      });

      const result = await generateAndSave(workflow);
      if (!result.success) return { success: false, output: `ControlNet generation failed: ${result.error}` };

      for (const fp of result.filePaths) {
        try {
          generatedImageStore.create({
            filePath: fp,
            prompt: args.prompt as string,
            model: checkpoint!,
            generationType: "controlnet",
            conversationId: (args._conversationId as number) ?? null,
            durationMs: result.durationMs,
            comfyuiPromptId: result.promptId,
          });
        } catch (_) {}
      }

      return {
        success: true,
        output: `ControlNet generation complete in ${(result.durationMs / 1000).toFixed(1)}s.\nModel: ${controlnetModel}\nFiles:\n${result.filePaths.map(p => `  ${p}`).join("\n")}`,
        metadata: { filePaths: result.filePaths, promptId: result.promptId, controlnetModel },
      };
    } catch (e: any) {
      return { success: false, output: `controlnet_generate error: ${e.message}` };
    }
  },
});

// ── 5. upscale_image ──────────────────────────────────────────────────

registerTool("upscale_image", {
  category: "image",
  requiresApproval: false,
  checkFn: () => !!settingsStore.get("comfyuiHost"),
  definition: {
    type: "function",
    function: {
      name: "upscale_image",
      description: "Upscale an image using an AI upscale model (e.g. Real-ESRGAN). Typically 4× upscale.",
      parameters: {
        type: "object",
        required: ["sourceImagePath"],
        properties: {
          sourceImagePath: { type: "string", description: "Absolute path to the source image to upscale." },
          upscaleModel: {
            type: "string",
            description: "Upscale model filename (default 'RealESRGAN_x4plus.pth'). Must be installed in ComfyUI.",
          },
        },
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const err = requireComfyUI();
    if (err) return { success: false, output: err };

    try {
      if (!fs.existsSync(args.sourceImagePath)) {
        return { success: false, output: `Source image not found: ${args.sourceImagePath}` };
      }

      let upscaleModel = (args.upscaleModel as string) || "RealESRGAN_x4plus.pth";

      // Verify the model is available
      const models = await listModels();
      if (models.upscale_models.length > 0 && !models.upscale_models.includes(upscaleModel)) {
        // Fall back to first available
        upscaleModel = models.upscale_models[0];
      } else if (models.upscale_models.length === 0) {
        return { success: false, output: "No upscale models installed in ComfyUI. Install RealESRGAN or similar." };
      }

      const imgUpload = await uploadImage(args.sourceImagePath);

      const workflow = upscaleTemplate.build({
        inputImage: imgUpload.name,
        upscaleModel,
      });

      const result = await generateAndSave(workflow);
      if (!result.success) return { success: false, output: `Upscaling failed: ${result.error}` };

      for (const fp of result.filePaths) {
        try {
          generatedImageStore.create({
            filePath: fp,
            model: upscaleModel,
            generationType: "upscale",
            conversationId: (args._conversationId as number) ?? null,
            durationMs: result.durationMs,
            comfyuiPromptId: result.promptId,
          });
        } catch (_) {}
      }

      return {
        success: true,
        output: `Upscaling complete in ${(result.durationMs / 1000).toFixed(1)}s using ${upscaleModel}.\nFiles:\n${result.filePaths.map(p => `  ${p}`).join("\n")}`,
        metadata: { filePaths: result.filePaths, promptId: result.promptId, upscaleModel },
      };
    } catch (e: any) {
      return { success: false, output: `upscale_image error: ${e.message}` };
    }
  },
});

// ── 6. remove_background ─────────────────────────────────────────────

registerTool("remove_background", {
  category: "image",
  requiresApproval: false,
  checkFn: () => !!settingsStore.get("comfyuiHost"),
  definition: {
    type: "function",
    function: {
      name: "remove_background",
      description: "Remove the background from an image using ComfyUI's RMBG or RemBG node. " +
        "Requires the ComfyUI-RMBG custom node to be installed.",
      parameters: {
        type: "object",
        required: ["sourceImagePath"],
        properties: {
          sourceImagePath: { type: "string", description: "Absolute path to the source image." },
        },
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const err = requireComfyUI();
    if (err) return { success: false, output: err };

    try {
      if (!fs.existsSync(args.sourceImagePath)) {
        return { success: false, output: `Source image not found: ${args.sourceImagePath}` };
      }

      // Check which background removal nodes are available
      const objectInfo = await getObjectInfo();
      const rmbgNode = objectInfo["RMBG"] || objectInfo["RemBG"] || objectInfo["BiRefNetUltra"] || null;
      const rmbgNodeName = objectInfo["RMBG"] ? "RMBG"
        : objectInfo["RemBG"] ? "RemBG"
        : objectInfo["BiRefNetUltra"] ? "BiRefNetUltra"
        : null;

      if (!rmbgNodeName) {
        return {
          success: false,
          output: "Background removal node not installed. Install ComfyUI-RMBG custom node from: " +
            "https://github.com/Acly/comfyui-tooling-nodes or https://github.com/kijai/ComfyUI-BRIA-RMBG",
        };
      }

      const imgUpload = await uploadImage(args.sourceImagePath);

      // Build dynamic workflow
      const workflow: Record<string, any> = {
        "1": {
          class_type: "LoadImage",
          inputs: { image: imgUpload.name },
        },
        "2": {
          class_type: rmbgNodeName,
          inputs: { image: ["1", 0] },
        },
        "3": {
          class_type: "SaveImage",
          inputs: { images: ["2", 0], filename_prefix: "Agent2077_rmbg" },
        },
      };

      const result = await generateAndSave(workflow);
      if (!result.success) return { success: false, output: `Background removal failed: ${result.error}` };

      for (const fp of result.filePaths) {
        try {
          generatedImageStore.create({
            filePath: fp,
            model: rmbgNodeName!,
            generationType: "bg_removal",
            conversationId: (args._conversationId as number) ?? null,
            durationMs: result.durationMs,
            comfyuiPromptId: result.promptId,
          });
        } catch (_) {}
      }

      return {
        success: true,
        output: `Background removal complete using ${rmbgNodeName}.\nFiles:\n${result.filePaths.map(p => `  ${p}`).join("\n")}`,
        metadata: { filePaths: result.filePaths, promptId: result.promptId },
      };
    } catch (e: any) {
      return { success: false, output: `remove_background error: ${e.message}` };
    }
  },
});

// ── 7. restore_faces ─────────────────────────────────────────────────

registerTool("restore_faces", {
  category: "image",
  requiresApproval: false,
  checkFn: () => !!settingsStore.get("comfyuiHost"),
  definition: {
    type: "function",
    function: {
      name: "restore_faces",
      description: "Restore and enhance faces in an image using CodeFormer or GFPGAN. " +
        "Requires a face restoration custom node to be installed in ComfyUI.",
      parameters: {
        type: "object",
        required: ["sourceImagePath"],
        properties: {
          sourceImagePath: { type: "string", description: "Absolute path to the source image." },
          fidelity: {
            type: "number",
            description: "Restoration fidelity 0.0 (max enhancement) to 1.0 (max fidelity to original). Default 0.5.",
          },
        },
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const err = requireComfyUI();
    if (err) return { success: false, output: err };

    try {
      if (!fs.existsSync(args.sourceImagePath)) {
        return { success: false, output: `Source image not found: ${args.sourceImagePath}` };
      }

      const objectInfo = await getObjectInfo();

      // Try known face restoration node names
      const candidates = ["CodeFormer", "GFPGANFaceRestore", "FaceRestoreCFWithModel", "RestoreFace"];
      const nodeType = candidates.find(n => objectInfo[n]) ?? null;

      if (!nodeType) {
        return {
          success: false,
          output:
            "Face restoration node not installed. Install a face restoration node such as:\n" +
            "  • CodeFormer: https://github.com/sczhou/CodeFormer\n" +
            "  • ComfyUI-GFPGAN: https://github.com/FurkanGozukara/ComfyUI-GFPGAN",
        };
      }

      const imgUpload = await uploadImage(args.sourceImagePath);
      const fidelity = args.fidelity ?? 0.5;

      // Build a generic workflow — inputs vary by node, so we pass common ones
      const nodeInputs: Record<string, any> = { image: ["1", 0] };
      const nodeInfo = objectInfo[nodeType];
      if (nodeInfo?.input?.required?.fidelity !== undefined || nodeInfo?.input?.optional?.fidelity !== undefined) {
        nodeInputs.fidelity = fidelity;
      }
      if (nodeInfo?.input?.required?.weight !== undefined) {
        nodeInputs.weight = fidelity;
      }

      const workflow: Record<string, any> = {
        "1": {
          class_type: "LoadImage",
          inputs: { image: imgUpload.name },
        },
        "2": {
          class_type: nodeType,
          inputs: nodeInputs,
        },
        "3": {
          class_type: "SaveImage",
          inputs: { images: ["2", 0], filename_prefix: "Agent2077_faces" },
        },
      };

      const result = await generateAndSave(workflow);
      if (!result.success) return { success: false, output: `Face restoration failed: ${result.error}` };

      for (const fp of result.filePaths) {
        try {
          generatedImageStore.create({
            filePath: fp,
            model: nodeType!,
            generationType: "face_restore",
            conversationId: (args._conversationId as number) ?? null,
            durationMs: result.durationMs,
            comfyuiPromptId: result.promptId,
          });
        } catch (_) {}
      }

      return {
        success: true,
        output: `Face restoration complete using ${nodeType} (fidelity: ${fidelity}).\nFiles:\n${result.filePaths.map(p => `  ${p}`).join("\n")}`,
        metadata: { filePaths: result.filePaths, promptId: result.promptId, nodeType },
      };
    } catch (e: any) {
      return { success: false, output: `restore_faces error: ${e.message}` };
    }
  },
});

// ── 8. list_comfyui_models ────────────────────────────────────────────

registerTool("list_comfyui_models", {
  category: "image",
  requiresApproval: false,
  definition: {
    type: "function",
    function: {
      name: "list_comfyui_models",
      description: "List all image models installed in ComfyUI: checkpoints (image generation models), LoRAs, VAE, ControlNet, and upscale models. " +
        "ALWAYS call this before generating images if you need to know which models are available, or if the user asks to use a specific model. " +
        "The checkpoint names returned are the exact names you must pass to generate_image, image_to_image, inpaint_image, etc.",
      parameters: {
        type: "object",
        required: [],
        properties: {},
      },
    },
  },
  async execute(): Promise<ToolResult> {
    const err = requireComfyUI();
    if (err) return { success: false, output: err };

    try {
      const models = await listModels();
      const lines: string[] = ["Installed ComfyUI models:"];

      lines.push(`\nCheckpoints (${models.checkpoints.length}):`);
      if (models.checkpoints.length) models.checkpoints.forEach(m => lines.push(`  • ${m}`));
      else lines.push("  (none)");

      lines.push(`\nLoRAs (${models.loras.length}):`);
      if (models.loras.length) models.loras.forEach(m => lines.push(`  • ${m}`));
      else lines.push("  (none)");

      lines.push(`\nVAE (${models.vae.length}):`);
      if (models.vae.length) models.vae.forEach(m => lines.push(`  • ${m}`));
      else lines.push("  (none)");

      lines.push(`\nControlNet (${models.controlnet.length}):`);
      if (models.controlnet.length) models.controlnet.forEach(m => lines.push(`  • ${m}`));
      else lines.push("  (none)");

      lines.push(`\nUpscale Models (${models.upscale_models.length}):`);
      if (models.upscale_models.length) models.upscale_models.forEach(m => lines.push(`  • ${m}`));
      else lines.push("  (none)");

      return {
        success: true,
        output: lines.join("\n"),
        metadata: models,
      };
    } catch (e: any) {
      return { success: false, output: `list_comfyui_models error: ${e.message}` };
    }
  },
});

// ── 9. comfyui_status ─────────────────────────────────────────────────

registerTool("comfyui_status", {
  category: "image",
  requiresApproval: false,
  checkFn: () => !!settingsStore.get("comfyuiHost"),
  definition: {
    type: "function",
    function: {
      name: "comfyui_status",
      description: "Check ComfyUI connection status and current generation queue.",
      parameters: {
        type: "object",
        required: [],
        properties: {},
      },
    },
  },
  async execute(): Promise<ToolResult> {
    const err = requireComfyUI();
    if (err) return { success: false, output: err };

    try {
      const [status, queue] = await Promise.all([checkConnection(), getQueue()]);

      if (!status.connected) {
        return {
          success: false,
          output: `ComfyUI is not reachable at ${status.host}:${status.port}. Is it running?`,
          metadata: { connected: false },
        };
      }

      const lines = [
        `ComfyUI is online at ${status.host}:${status.port}`,
        `Queue: ${queue.running.length} running, ${queue.pending.length} pending`,
      ];

      if (status.systemStats) {
        const sys = status.systemStats;
        if (sys.system?.cuda_max_reserved_gb) {
          lines.push(`VRAM: ${sys.system.cuda_max_reserved_gb.toFixed(2)} GB`);
        }
        if (sys.system?.ram_total && sys.system?.ram_free) {
          const totalGb = (sys.system.ram_total / 1e9).toFixed(1);
          const freeGb = (sys.system.ram_free / 1e9).toFixed(1);
          lines.push(`RAM: ${freeGb} GB free / ${totalGb} GB total`);
        }
      }

      if (queue.running.length > 0) {
        lines.push("\nCurrently running:");
        queue.running.slice(0, 5).forEach((item: any) => {
          lines.push(`  • Prompt ID: ${item[1]}`);
        });
      }

      return {
        success: true,
        output: lines.join("\n"),
        metadata: { status, queue },
      };
    } catch (e: any) {
      return { success: false, output: `comfyui_status error: ${e.message}` };
    }
  },
});

// ── 10. run_comfyui_workflow ──────────────────────────────────────────

registerTool("run_comfyui_workflow", {
  category: "image",
  requiresApproval: false,
  checkFn: () => !!settingsStore.get("comfyuiHost"),
  definition: {
    type: "function",
    function: {
      name: "run_comfyui_workflow",
      description:
        "Execute an arbitrary ComfyUI workflow by providing the raw API JSON. " +
        "Validates the workflow against available nodes before running. " +
        "Returns the generated image file paths.",
      parameters: {
        type: "object",
        required: ["workflowJson"],
        properties: {
          workflowJson: {
            type: "string",
            description: "ComfyUI API-format workflow JSON string. Each key is a node ID with class_type and inputs.",
          },
          outputDir: {
            type: "string",
            description: "Optional absolute path to directory for saving output images. Defaults to ~/agent2077-images/.",
          },
        },
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const err = requireComfyUI();
    if (err) return { success: false, output: err };

    try {
      let workflow: Record<string, any>;
      try {
        workflow = JSON.parse(args.workflowJson);
      } catch (parseErr: any) {
        return { success: false, output: `Invalid workflow JSON: ${parseErr.message}` };
      }

      // Validate before running
      const validation = await validateWorkflow(workflow);
      if (!validation.valid) {
        return {
          success: false,
          output: `Workflow validation failed:\n${validation.errors.map(e => `  • ${e}`).join("\n")}`,
          metadata: { validationErrors: validation.errors },
        };
      }

      const outputDir = args.outputDir || IMAGES_DIR;
      const result = await generateAndSave(workflow, outputDir);

      if (!result.success) {
        return { success: false, output: `Workflow execution failed: ${result.error}` };
      }

      return {
        success: true,
        output: `Workflow completed in ${(result.durationMs / 1000).toFixed(1)}s.\nPrompt ID: ${result.promptId}\nFiles:\n${result.filePaths.map(p => `  ${p}`).join("\n")}`,
        metadata: { filePaths: result.filePaths, promptId: result.promptId, durationMs: result.durationMs },
      };
    } catch (e: any) {
      return { success: false, output: `run_comfyui_workflow error: ${e.message}` };
    }
  },
});

// ── 11. save_comfyui_workflow ─────────────────────────────────────────

registerTool("save_comfyui_workflow", {
  category: "image",
  requiresApproval: false,
  checkFn: () => !!settingsStore.get("comfyuiHost"),
  definition: {
    type: "function",
    function: {
      name: "save_comfyui_workflow",
      description: "Save a ComfyUI workflow as a named template for later reuse. " +
        "Stores to ~/agent2077-images/workflows/ as a JSON file.",
      parameters: {
        type: "object",
        required: ["name", "workflowJson"],
        properties: {
          name: { type: "string", description: "Short name / identifier for the workflow (used as filename)." },
          description: { type: "string", description: "Human-readable description of what the workflow does." },
          workflowJson: { type: "string", description: "ComfyUI API-format workflow JSON string." },
          category: { type: "string", description: "Optional category tag (e.g. 'txt2img', 'upscale', 'custom')." },
        },
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    try {
      // Parse and validate JSON
      let workflow: Record<string, any>;
      try {
        workflow = JSON.parse(args.workflowJson);
      } catch (parseErr: any) {
        return { success: false, output: `Invalid workflow JSON: ${parseErr.message}` };
      }

      const workflowsDir = path.join(IMAGES_DIR, "workflows");
      if (!fs.existsSync(workflowsDir)) fs.mkdirSync(workflowsDir, { recursive: true });

      // Sanitize name for use as filename
      const safeName = (args.name as string).replace(/[^a-zA-Z0-9_\-]/g, "_").toLowerCase();
      const filePath = path.join(workflowsDir, `${safeName}.json`);

      const templateData = {
        name: args.name,
        description: args.description || "",
        category: args.category || "custom",
        savedAt: new Date().toISOString(),
        workflow,
      };

      fs.writeFileSync(filePath, JSON.stringify(templateData, null, 2), "utf-8");

      return {
        success: true,
        output: `Workflow "${args.name}" saved to ${filePath}`,
        metadata: { filePath, name: args.name, category: args.category || "custom" },
      };
    } catch (e: any) {
      return { success: false, output: `save_comfyui_workflow error: ${e.message}` };
    }
  },
});

// ── 12. build_comfyui_workflow ────────────────────────────────────────

registerTool("build_comfyui_workflow", {
  category: "image",
  requiresApproval: false,
  checkFn: () => !!settingsStore.get("comfyuiHost"),
  definition: {
    type: "function",
    function: {
      name: "build_comfyui_workflow",
      description:
        "Dynamically build a ComfyUI workflow from a natural language description. " +
        "Assembles a node graph based on keywords in the description. " +
        "Returns the workflow JSON without executing it — pass it to run_comfyui_workflow to execute.",
      parameters: {
        type: "object",
        required: ["description"],
        properties: {
          description: {
            type: "string",
            description:
              "Natural language description of the workflow to build. " +
              "Examples: 'txt2img with lora and upscale', 'inpaint with controlnet canny', 'basic text to image'.",
          },
          checkpoint: { type: "string", description: "Checkpoint model to use. Auto-selected if omitted." },
        },
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const err = requireComfyUI();
    if (err) return { success: false, output: err };

    try {
      const desc = (args.description as string).toLowerCase();
      const builder = new WorkflowBuilder();

      try {
        await builder.init();
      } catch (initErr: any) {
        return { success: false, output: `Failed to connect to ComfyUI for workflow building: ${initErr.message}` };
      }

      // Resolve checkpoint
      let checkpoint = args.checkpoint as string | undefined;
      if (!checkpoint) {
        const models = await listModels();
        checkpoint = models.checkpoints[0];
        if (!checkpoint && !desc.includes("upscale")) {
          return { success: false, output: "No checkpoint models found. Cannot build workflow." };
        }
        checkpoint = checkpoint || "placeholder.ckpt";
      }

      const buildLog: string[] = [];
      let workflowJson: Record<string, any>;

      // ── Upscale-only workflow ───────────────────────────────────────
      if (desc.includes("upscale") && !desc.includes("txt2img") && !desc.includes("generate")) {
        buildLog.push("Building upscale workflow.");
        workflowJson = upscaleTemplate.build({
          inputImage: "input.png",
          upscaleModel: "RealESRGAN_x4plus.pth",
        });
        buildLog.push("Base: upscale template (LoadImage → UpscaleModelLoader → ImageUpscaleWithModel → SaveImage).");

      // ── Inpaint workflow ────────────────────────────────────────────
      } else if (desc.includes("inpaint") || desc.includes("mask")) {
        buildLog.push("Building inpainting workflow.");
        workflowJson = inpaintTemplate.build({
          prompt: "your prompt here",
          checkpoint,
          inputImage: "input.png",
          maskImage: "mask.png",
          denoise: 0.8,
          seed: -1,
        });
        buildLog.push("Base: inpaint template (CheckpointLoader → CLIP → LoadImage×2 → VAEEncode → SetLatentNoiseMask → KSampler → VAEDecode → SaveImage).");

      // ── ControlNet workflow ─────────────────────────────────────────
      } else if (desc.includes("controlnet") || desc.includes("control net") || desc.includes("canny") || desc.includes("depth") || desc.includes("pose")) {
        buildLog.push("Building ControlNet workflow.");
        workflowJson = controlnetTemplate.build({
          prompt: "your prompt here",
          checkpoint,
          controlnetModel: "control_v11p_sd15_canny.pth",
          controlImage: "control.png",
          strength: 1.0,
          seed: -1,
        });
        buildLog.push("Base: controlnet template (CheckpointLoader → CLIP×2 → ControlNetLoader → LoadImage → ControlNetApplyAdvanced → EmptyLatentImage → KSampler → VAEDecode → SaveImage).");

      // ── txt2img + optional extras ───────────────────────────────────
      } else {
        buildLog.push("Building txt2img workflow.");

        const hasLora = desc.includes("lora");
        const hasUpscale = desc.includes("upscale");

        workflowJson = buildTxt2Img({
          prompt: "your prompt here",
          checkpoint,
          seed: -1,
          lora: hasLora ? { name: "your_lora.safetensors", strengthModel: 1.0 } : undefined,
        });

        buildLog.push("Base: txt2img (CheckpointLoader → CLIPTextEncode×2 → EmptyLatentImage → KSampler → VAEDecode → SaveImage).");

        if (hasLora) {
          buildLog.push("Added LoRA loader node (node 8) between checkpoint and KSampler.");
        }

        if (hasUpscale) {
          buildLog.push("Appending upscale stage after VAEDecode.");
          // Rewire SaveImage → ImageUpscaleWithModel → new SaveImage
          const upscaleStageId = "20";
          const upscaleModelId = "21";
          const finalSaveId = "22";

          // Find the VAEDecode node (node "6" in standard txt2img)
          workflowJson[upscaleModelId] = {
            class_type: "UpscaleModelLoader",
            inputs: { model_name: "RealESRGAN_x4plus.pth" },
          };
          workflowJson[upscaleStageId] = {
            class_type: "ImageUpscaleWithModel",
            inputs: {
              upscale_model: [upscaleModelId, 0],
              image: ["6", 0], // output of VAEDecode
            },
          };
          workflowJson[finalSaveId] = {
            class_type: "SaveImage",
            inputs: { images: [upscaleStageId, 0], filename_prefix: "Agent2077_upscaled" },
          };
          // Remove old SaveImage (node 7) to avoid redundant output
          delete workflowJson["7"];
          buildLog.push("Upscale stage: UpscaleModelLoader → ImageUpscaleWithModel → SaveImage.");
        }
      }

      // Validate the assembled workflow
      const validation = await validateWorkflow(workflowJson);
      const validationNote = validation.valid
        ? "Workflow validated successfully against ComfyUI node info."
        : `Validation warnings (may need manual fixes):\n${validation.errors.map(e => `  • ${e}`).join("\n")}`;

      buildLog.push(validationNote);

      return {
        success: true,
        output: [
          "Built workflow:",
          ...buildLog.map(l => `  • ${l}`),
          "",
          "Workflow JSON (pass to run_comfyui_workflow to execute):",
          JSON.stringify(workflowJson, null, 2),
        ].join("\n"),
        metadata: {
          workflowJson,
          validationErrors: validation.errors,
        },
      };
    } catch (e: any) {
      return { success: false, output: `build_comfyui_workflow error: ${e.message}` };
    }
  },
});

// ── 13. comfyui_interrupt ─────────────────────────────────────────────

registerTool("comfyui_interrupt", {
  category: "image",
  requiresApproval: false,
  checkFn: () => !!settingsStore.get("comfyuiHost"),
  definition: {
    type: "function",
    function: {
      name: "comfyui_interrupt",
      description: "Interrupt the currently running ComfyUI generation. Stops the active generation immediately.",
      parameters: {
        type: "object",
        required: [],
        properties: {},
      },
    },
  },
  async execute(): Promise<ToolResult> {
    const err = requireComfyUI();
    if (err) return { success: false, output: err };

    try {
      await interrupt();
      return { success: true, output: "ComfyUI generation interrupted successfully." };
    } catch (e: any) {
      return { success: false, output: `comfyui_interrupt error: ${e.message}` };
    }
  },
});
