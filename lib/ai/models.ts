/**
 * The on-device AI model registry.
 *
 * Model weights are NEVER committed to the repository — they are downloaded
 * on first use from the URLs below and cached in the browser (Cache API,
 * see modelCache.ts). Both defaults were chosen for their licenses as much
 * as their quality:
 *
 * - Segmentation: U²-Netp (Apache-2.0, https://github.com/xuebinqin/U-2-Net),
 *   served from the rembg project's release mirror of the official weights.
 *   4.6 MB. ISNet-general-use is somewhat better on hair and fuzz, but at
 *   176 MB the difference does not survive a pipeline that ends in marching
 *   squares, curve fitting and a manual brush.
 * - Depth: Depth Anything V2 **Small** (Apache-2.0,
 *   https://github.com/DepthAnything/Depth-Anything-V2 — only the Small
 *   variant is Apache-2.0; Base/Large are CC-BY-NC and must not be used),
 *   served from fabio-sim/Depth-Anything-ONNX's Apache-2.0 export. 99.4 MB,
 *   downloaded once, with the size stated before anything starts.
 *
 * Self-hosting: set NEXT_PUBLIC_AI_MODEL_BASE_URL and place both files
 * (by their `fileName` below) under that base.
 */

export type AiModelId = "segmentation" | "depth";

export interface AiModelSpec {
  id: AiModelId;
  /** Short Hebrew name for download notices. */
  nameHe: string;
  fileName: string;
  defaultUrl: string;
  /** Verified Content-Length of the default file, for the download notice. */
  approxBytes: number;
  /** Square model input edge, px. */
  inputSize: number;
  /** Per-channel normalisation (ImageNet convention for both models). */
  mean: [number, number, number];
  std: [number, number, number];
  license: string;
}

export const AI_MODELS: Record<AiModelId, AiModelSpec> = {
  segmentation: {
    id: "segmentation",
    nameHe: "זיהוי נושא (U²-Netp)",
    fileName: "u2netp.onnx",
    defaultUrl:
      "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx",
    approxBytes: 4_574_861,
    inputSize: 320,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    license: "Apache-2.0",
  },
  depth: {
    id: "depth",
    nameHe: "אומדן עומק (Depth Anything V2 Small)",
    fileName: "depth_anything_v2_vits.onnx",
    defaultUrl:
      "https://github.com/fabio-sim/Depth-Anything-ONNX/releases/download/v2.0.0/depth_anything_v2_vits.onnx",
    approxBytes: 99_373_606,
    inputSize: 518,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    license: "Apache-2.0",
  },
};

/**
 * Hard cap on a model download. A model file is opaque bytes handed to a
 * sandboxed runtime; the one thing we enforce about its content is that it
 * cannot be unbounded.
 */
export const MAX_MODEL_BYTES = 256 * 1024 * 1024;

/**
 * Where the BROWSER loads a model from.
 *
 * By default this is our own origin (/api/ai-models/…): the public homes of
 * the weights — GitHub release assets — send no Access-Control-Allow-Origin
 * header on any hop of their redirect chain, so a direct cross-origin fetch
 * is blocked by the browser before a single byte arrives. The same-origin
 * route (lib/server/aiModelProxy.ts) streams `defaultUrl` through instead,
 * which also means the user's browser never contacts a third party at all.
 *
 * A configured NEXT_PUBLIC_AI_MODEL_BASE_URL is used directly (self-hosting;
 * that host is expected to be same-origin or CORS-enabled).
 */
export function modelUrl(spec: AiModelSpec): string {
  const base = process.env.NEXT_PUBLIC_AI_MODEL_BASE_URL;
  if (base) return `${base.replace(/\/+$/, "")}/${spec.fileName}`;
  return `/api/ai-models/${spec.fileName}`;
}

/** "4.6MB" / "99.4MB" — for download notices. */
export function formatModelSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
