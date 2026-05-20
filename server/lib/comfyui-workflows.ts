/**
 * ComfyUI Workflow Templates + Dynamic Builder.
 * 
 * Template workflows are in ComfyUI's API JSON format (not the frontend format).
 * Each node has a string ID, class_type, and inputs object.
 * Inputs can be literal values or links: [nodeId, outputSlot].
 * 
 * The dynamic builder constructs workflows programmatically using /object_info
 * to validate node types and connections.
 */
import { getObjectInfo, type NodeInfo } from "./comfyui-client.js";

// ── Types ──────────────────────────────────────────────────────────

export interface WorkflowTemplate {
  name: string;
  category: string;
  description: string;
  /** The API JSON with placeholder values to be filled */
  build: (params: Record<string, any>) => Record<string, any>;
  /** Which parameters this template accepts */
  parameters: ParameterDef[];
}

export interface ParameterDef {
  name: string;
  type: "string" | "number" | "boolean" | "select";
  description: string;
  default: any;
  options?: string[]; // for select type
  min?: number;
  max?: number;
}

// ── Common defaults ────────────────────────────────────────────────

const DEFAULTS = {
  width: 1024,
  height: 1024,
  steps: 20,
  cfg: 7.0,
  sampler: "euler",
  scheduler: "normal",
  denoise: 1.0,
  seed: () => Math.floor(Math.random() * 2147483647),
  negativePrompt: "blurry, bad quality, watermark, text, deformed",
};

// ── Template: Text-to-Image ────────────────────────────────────────

export const txt2imgTemplate: WorkflowTemplate = {
  name: "Text to Image",
  category: "txt2img",
  description: "Generate an image from a text prompt using any checkpoint model.",
  parameters: [
    { name: "prompt", type: "string", description: "Positive prompt", default: "" },
    { name: "negativePrompt", type: "string", description: "Negative prompt", default: DEFAULTS.negativePrompt },
    { name: "checkpoint", type: "string", description: "Checkpoint model name", default: "" },
    { name: "width", type: "number", description: "Image width", default: DEFAULTS.width, min: 64, max: 4096 },
    { name: "height", type: "number", description: "Image height", default: DEFAULTS.height, min: 64, max: 4096 },
    { name: "steps", type: "number", description: "Sampling steps", default: DEFAULTS.steps, min: 1, max: 150 },
    { name: "cfg", type: "number", description: "CFG scale", default: DEFAULTS.cfg, min: 1, max: 30 },
    { name: "sampler", type: "string", description: "Sampler name", default: DEFAULTS.sampler },
    { name: "scheduler", type: "string", description: "Scheduler", default: DEFAULTS.scheduler },
    { name: "seed", type: "number", description: "Seed (-1 for random)", default: -1 },
    { name: "batchSize", type: "number", description: "Batch size", default: 1, min: 1, max: 8 },
  ],
  build(params) {
    const seed = params.seed === -1 ? DEFAULTS.seed() : params.seed;
    return {
      "1": {
        class_type: "CheckpointLoaderSimple",
        inputs: { ckpt_name: params.checkpoint },
      },
      "2": {
        class_type: "CLIPTextEncode",
        inputs: { text: params.prompt, clip: ["1", 1] },
      },
      "3": {
        class_type: "CLIPTextEncode",
        inputs: { text: params.negativePrompt || DEFAULTS.negativePrompt, clip: ["1", 1] },
      },
      "4": {
        class_type: "EmptyLatentImage",
        inputs: {
          width: params.width || DEFAULTS.width,
          height: params.height || DEFAULTS.height,
          batch_size: params.batchSize || 1,
        },
      },
      "5": {
        class_type: "KSampler",
        inputs: {
          model: ["1", 0],
          positive: ["2", 0],
          negative: ["3", 0],
          latent_image: ["4", 0],
          seed,
          steps: params.steps || DEFAULTS.steps,
          cfg: params.cfg ?? DEFAULTS.cfg,
          sampler_name: params.sampler || DEFAULTS.sampler,
          scheduler: params.scheduler || DEFAULTS.scheduler,
          denoise: 1.0,
        },
      },
      "6": {
        class_type: "VAEDecode",
        inputs: { samples: ["5", 0], vae: ["1", 2] },
      },
      "7": {
        class_type: "SaveImage",
        inputs: { images: ["6", 0], filename_prefix: "Agent2077" },
      },
    };
  },
};

// ── Template: Image-to-Image ───────────────────────────────────────

export const img2imgTemplate: WorkflowTemplate = {
  name: "Image to Image",
  category: "img2img",
  description: "Transform an existing image with a text prompt.",
  parameters: [
    { name: "prompt", type: "string", description: "Positive prompt", default: "" },
    { name: "negativePrompt", type: "string", description: "Negative prompt", default: DEFAULTS.negativePrompt },
    { name: "checkpoint", type: "string", description: "Checkpoint model", default: "" },
    { name: "inputImage", type: "string", description: "Input image filename (in ComfyUI input folder)", default: "" },
    { name: "denoise", type: "number", description: "Denoise strength (0.0-1.0)", default: 0.7, min: 0, max: 1 },
    { name: "steps", type: "number", description: "Steps", default: DEFAULTS.steps },
    { name: "cfg", type: "number", description: "CFG scale", default: DEFAULTS.cfg },
    { name: "sampler", type: "string", description: "Sampler", default: DEFAULTS.sampler },
    { name: "seed", type: "number", description: "Seed", default: -1 },
  ],
  build(params) {
    const seed = params.seed === -1 ? DEFAULTS.seed() : params.seed;
    return {
      "1": {
        class_type: "CheckpointLoaderSimple",
        inputs: { ckpt_name: params.checkpoint },
      },
      "2": {
        class_type: "CLIPTextEncode",
        inputs: { text: params.prompt, clip: ["1", 1] },
      },
      "3": {
        class_type: "CLIPTextEncode",
        inputs: { text: params.negativePrompt || DEFAULTS.negativePrompt, clip: ["1", 1] },
      },
      "4": {
        class_type: "LoadImage",
        inputs: { image: params.inputImage },
      },
      "5": {
        class_type: "VAEEncode",
        inputs: { pixels: ["4", 0], vae: ["1", 2] },
      },
      "6": {
        class_type: "KSampler",
        inputs: {
          model: ["1", 0],
          positive: ["2", 0],
          negative: ["3", 0],
          latent_image: ["5", 0],
          seed,
          steps: params.steps || DEFAULTS.steps,
          cfg: params.cfg ?? DEFAULTS.cfg,
          sampler_name: params.sampler || DEFAULTS.sampler,
          scheduler: params.scheduler || DEFAULTS.scheduler,
          denoise: params.denoise ?? 0.7,
        },
      },
      "7": {
        class_type: "VAEDecode",
        inputs: { samples: ["6", 0], vae: ["1", 2] },
      },
      "8": {
        class_type: "SaveImage",
        inputs: { images: ["7", 0], filename_prefix: "Agent2077_img2img" },
      },
    };
  },
};

// ── Template: Upscale ──────────────────────────────────────────────

export const upscaleTemplate: WorkflowTemplate = {
  name: "Upscale Image",
  category: "upscale",
  description: "Upscale an image using an upscale model (Real-ESRGAN, 4x-UltraSharp, etc.).",
  parameters: [
    { name: "inputImage", type: "string", description: "Input image filename", default: "" },
    { name: "upscaleModel", type: "string", description: "Upscale model name", default: "RealESRGAN_x4plus.pth" },
  ],
  build(params) {
    return {
      "1": {
        class_type: "LoadImage",
        inputs: { image: params.inputImage },
      },
      "2": {
        class_type: "UpscaleModelLoader",
        inputs: { model_name: params.upscaleModel },
      },
      "3": {
        class_type: "ImageUpscaleWithModel",
        inputs: { upscale_model: ["2", 0], image: ["1", 0] },
      },
      "4": {
        class_type: "SaveImage",
        inputs: { images: ["3", 0], filename_prefix: "Agent2077_upscale" },
      },
    };
  },
};

// ── Template: Inpainting ───────────────────────────────────────────

export const inpaintTemplate: WorkflowTemplate = {
  name: "Inpaint",
  category: "inpaint",
  description: "Mask a region of an image and regenerate it with a prompt.",
  parameters: [
    { name: "prompt", type: "string", description: "What to generate in the masked area", default: "" },
    { name: "negativePrompt", type: "string", description: "Negative prompt", default: DEFAULTS.negativePrompt },
    { name: "checkpoint", type: "string", description: "Checkpoint model", default: "" },
    { name: "inputImage", type: "string", description: "Input image filename", default: "" },
    { name: "maskImage", type: "string", description: "Mask image filename (white = inpaint area)", default: "" },
    { name: "denoise", type: "number", description: "Denoise strength", default: 0.8 },
    { name: "steps", type: "number", description: "Steps", default: DEFAULTS.steps },
    { name: "cfg", type: "number", description: "CFG scale", default: DEFAULTS.cfg },
    { name: "seed", type: "number", description: "Seed", default: -1 },
  ],
  build(params) {
    const seed = params.seed === -1 ? DEFAULTS.seed() : params.seed;
    return {
      "1": {
        class_type: "CheckpointLoaderSimple",
        inputs: { ckpt_name: params.checkpoint },
      },
      "2": {
        class_type: "CLIPTextEncode",
        inputs: { text: params.prompt, clip: ["1", 1] },
      },
      "3": {
        class_type: "CLIPTextEncode",
        inputs: { text: params.negativePrompt || DEFAULTS.negativePrompt, clip: ["1", 1] },
      },
      "4": {
        class_type: "LoadImage",
        inputs: { image: params.inputImage },
      },
      "5": {
        class_type: "LoadImage",
        inputs: { image: params.maskImage },
      },
      "6": {
        class_type: "VAEEncode",
        inputs: { pixels: ["4", 0], vae: ["1", 2] },
      },
      "7": {
        class_type: "SetLatentNoiseMask",
        inputs: { samples: ["6", 0], mask: ["5", 1] },
      },
      "8": {
        class_type: "KSampler",
        inputs: {
          model: ["1", 0],
          positive: ["2", 0],
          negative: ["3", 0],
          latent_image: ["7", 0],
          seed,
          steps: params.steps || DEFAULTS.steps,
          cfg: params.cfg ?? DEFAULTS.cfg,
          sampler_name: params.sampler || DEFAULTS.sampler,
          scheduler: params.scheduler || DEFAULTS.scheduler,
          denoise: params.denoise ?? 0.8,
        },
      },
      "9": {
        class_type: "VAEDecode",
        inputs: { samples: ["8", 0], vae: ["1", 2] },
      },
      "10": {
        class_type: "SaveImage",
        inputs: { images: ["9", 0], filename_prefix: "Agent2077_inpaint" },
      },
    };
  },
};

// ── Template: ControlNet ───────────────────────────────────────────

export const controlnetTemplate: WorkflowTemplate = {
  name: "ControlNet Generation",
  category: "controlnet",
  description: "Generate an image guided by a control image (canny edge, depth, pose, etc.).",
  parameters: [
    { name: "prompt", type: "string", description: "Positive prompt", default: "" },
    { name: "negativePrompt", type: "string", description: "Negative prompt", default: DEFAULTS.negativePrompt },
    { name: "checkpoint", type: "string", description: "Checkpoint model", default: "" },
    { name: "controlnetModel", type: "string", description: "ControlNet model name", default: "" },
    { name: "controlImage", type: "string", description: "Control image filename", default: "" },
    { name: "strength", type: "number", description: "ControlNet strength (0.0-1.0)", default: 1.0 },
    { name: "width", type: "number", description: "Width", default: DEFAULTS.width },
    { name: "height", type: "number", description: "Height", default: DEFAULTS.height },
    { name: "steps", type: "number", description: "Steps", default: DEFAULTS.steps },
    { name: "cfg", type: "number", description: "CFG", default: DEFAULTS.cfg },
    { name: "seed", type: "number", description: "Seed", default: -1 },
  ],
  build(params) {
    const seed = params.seed === -1 ? DEFAULTS.seed() : params.seed;
    return {
      "1": {
        class_type: "CheckpointLoaderSimple",
        inputs: { ckpt_name: params.checkpoint },
      },
      "2": {
        class_type: "CLIPTextEncode",
        inputs: { text: params.prompt, clip: ["1", 1] },
      },
      "3": {
        class_type: "CLIPTextEncode",
        inputs: { text: params.negativePrompt || DEFAULTS.negativePrompt, clip: ["1", 1] },
      },
      "4": {
        class_type: "ControlNetLoader",
        inputs: { control_net_name: params.controlnetModel },
      },
      "5": {
        class_type: "LoadImage",
        inputs: { image: params.controlImage },
      },
      "6": {
        class_type: "ControlNetApplyAdvanced",
        inputs: {
          positive: ["2", 0],
          negative: ["3", 0],
          control_net: ["4", 0],
          image: ["5", 0],
          strength: params.strength ?? 1.0,
          start_percent: 0.0,
          end_percent: 1.0,
        },
      },
      "7": {
        class_type: "EmptyLatentImage",
        inputs: { width: params.width || DEFAULTS.width, height: params.height || DEFAULTS.height, batch_size: 1 },
      },
      "8": {
        class_type: "KSampler",
        inputs: {
          model: ["1", 0],
          positive: ["6", 0],
          negative: ["6", 1],
          latent_image: ["7", 0],
          seed,
          steps: params.steps || DEFAULTS.steps,
          cfg: params.cfg ?? DEFAULTS.cfg,
          sampler_name: params.sampler || DEFAULTS.sampler,
          scheduler: params.scheduler || DEFAULTS.scheduler,
          denoise: 1.0,
        },
      },
      "9": {
        class_type: "VAEDecode",
        inputs: { samples: ["8", 0], vae: ["1", 2] },
      },
      "10": {
        class_type: "SaveImage",
        inputs: { images: ["9", 0], filename_prefix: "Agent2077_controlnet" },
      },
    };
  },
};

// ── All templates ──────────────────────────────────────────────────

export const WORKFLOW_TEMPLATES: Record<string, WorkflowTemplate> = {
  txt2img: txt2imgTemplate,
  img2img: img2imgTemplate,
  upscale: upscaleTemplate,
  inpaint: inpaintTemplate,
  controlnet: controlnetTemplate,
};

// ── Dynamic Workflow Builder ───────────────────────────────────────

interface WorkflowNode {
  id: string;
  class_type: string;
  inputs: Record<string, any>;
}

/**
 * Build a workflow programmatically by chaining nodes.
 * Validates connections against /object_info.
 */
export class WorkflowBuilder {
  private nodes: Map<string, WorkflowNode> = new Map();
  private nextId = 1;
  private objectInfo: Record<string, NodeInfo> | null = null;

  async init(): Promise<void> {
    this.objectInfo = await getObjectInfo();
  }

  /**
   * Add a node to the workflow. Returns the node ID.
   */
  addNode(classType: string, inputs: Record<string, any> = {}): string {
    const id = String(this.nextId++);
    this.nodes.set(id, { id, class_type: classType, inputs });
    return id;
  }

  /**
   * Connect output of one node to input of another.
   * sourceSlot is the output index of the source node.
   */
  connect(sourceNodeId: string, sourceSlot: number, targetNodeId: string, inputName: string): void {
    const target = this.nodes.get(targetNodeId);
    if (!target) throw new Error(`Target node ${targetNodeId} not found`);
    target.inputs[inputName] = [sourceNodeId, sourceSlot];
  }

  /**
   * Set a literal input value on a node.
   */
  setInput(nodeId: string, inputName: string, value: any): void {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`Node ${nodeId} not found`);
    node.inputs[inputName] = value;
  }

  /**
   * Validate the workflow against object_info.
   */
  validate(): { valid: boolean; errors: string[] } {
    if (!this.objectInfo) return { valid: false, errors: ["object_info not loaded — call init() first"] };

    const errors: string[] = [];

    for (const [id, node] of this.nodes) {
      const info = this.objectInfo[node.class_type];
      if (!info) {
        errors.push(`Node ${id}: unknown class_type "${node.class_type}"`);
        continue;
      }

      // Check required inputs
      if (info.input?.required) {
        for (const inputName of Object.keys(info.input.required)) {
          if (!(inputName in node.inputs)) {
            errors.push(`Node ${id} (${node.class_type}): missing required input "${inputName}"`);
          }
        }
      }

      // Check links reference valid nodes
      for (const [inputName, value] of Object.entries(node.inputs)) {
        if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string") {
          if (!this.nodes.has(value[0])) {
            errors.push(`Node ${id} (${node.class_type}): input "${inputName}" links to non-existent node ${value[0]}`);
          }
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Export to ComfyUI API JSON format.
   */
  toApiJson(): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [id, node] of this.nodes) {
      result[id] = { class_type: node.class_type, inputs: { ...node.inputs } };
    }
    return result;
  }

  /**
   * Get available nodes matching a category filter.
   */
  getAvailableNodes(categoryFilter?: string): string[] {
    if (!this.objectInfo) return [];
    return Object.entries(this.objectInfo)
      .filter(([, info]) => !categoryFilter || info.category.includes(categoryFilter))
      .map(([name]) => name);
  }

  /**
   * Get info about a specific node type.
   */
  getNodeInfo(classType: string): NodeInfo | undefined {
    return this.objectInfo?.[classType];
  }
}

/**
 * Helper: Build a standard txt2img workflow with optional extras.
 */
export function buildTxt2Img(params: {
  prompt: string;
  negativePrompt?: string;
  checkpoint: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  sampler?: string;
  scheduler?: string;
  seed?: number;
  batchSize?: number;
  lora?: { name: string; strengthModel?: number; strengthClip?: number };
}): Record<string, any> {
  const workflow = txt2imgTemplate.build({
    ...params,
    seed: params.seed ?? -1,
  });

  // If LoRA requested, insert LoraLoader between checkpoint and CLIP/KSampler
  if (params.lora) {
    workflow["8"] = {
      class_type: "LoraLoader",
      inputs: {
        model: ["1", 0],
        clip: ["1", 1],
        lora_name: params.lora.name,
        strength_model: params.lora.strengthModel ?? 1.0,
        strength_clip: params.lora.strengthClip ?? 1.0,
      },
    };
    // Rewire: CLIP nodes use LoRA output, KSampler uses LoRA model
    workflow["2"].inputs.clip = ["8", 1];
    workflow["3"].inputs.clip = ["8", 1];
    workflow["5"].inputs.model = ["8", 0];
  }

  return workflow;
}
