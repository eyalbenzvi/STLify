/**
 * The AI job registry: on-device inference addressable by name, following
 * lib/geometry/jobs/registry.ts — plain JSON + transferable payloads, so the
 * identical code runs in the AI worker or in-process (SSR, tests, browsers
 * where worker creation fails).
 *
 * Each job owns the whole chain for one model: download (cached after the
 * first time), session creation (cached per thread), preprocessing,
 * inference, normalisation. Progress is reported in Hebrew across all of it,
 * and cancellation is checked between the expensive stages.
 */

import { formatModelSize, AI_MODELS, type AiModelId, type AiModelSpec } from "./models";
import { loadModelBytes, evictCachedModel } from "./modelCache";
import { minMaxNormalize, rgbaToChwTensor } from "./imageTensor";
import {
  createOnnxSession,
  type AiExecutionProvider,
  type AiSession,
  type AiSessionFactory,
  type AiSessionOptions,
} from "./onnx";
import { AiError } from "./errors";

export type AiProgressReporter = (fraction: number, labelHe: string) => void;

export interface AiJobContext {
  onProgress: AiProgressReporter;
  /** Throws if the job has been cancelled; checked between stages. */
  throwIfCancelled: () => void;
  /** Aborts in-flight downloads when the job is cancelled. */
  signal?: AbortSignal;
  /** Injected by tests; production uses the real ONNX runtime. */
  sessionFactory?: AiSessionFactory;
}

/** Raised when an AI job is cancelled; callers treat it as "no result". */
export class AiJobCancelledError extends Error {
  constructor() {
    super("ai job cancelled");
    this.name = "AiJobCancelledError";
  }
}

export interface AiImagePayload {
  /** Row-major RGBA pixels of the decoded source image. */
  rgba: Uint8Array;
  width: number;
  height: number;
}

export interface AiInferenceResult {
  /** Row-major single-channel map at model resolution, min-max normalised 0..1. */
  map: Float32Array;
  width: number;
  height: number;
  provider: AiExecutionProvider;
  /** False when the model output was flat — it saw nothing to separate. */
  hasSignal: boolean;
}

export interface AiJobMap {
  segmentImage: { payload: AiImagePayload; result: AiInferenceResult };
  estimateDepth: { payload: AiImagePayload; result: AiInferenceResult };
}

export type AiJobName = keyof AiJobMap;

/**
 * Sessions are cached per thread (one per model) — the download and the
 * session build are paid once per browser session, which is what makes the
 * dialog preview responsive after the first run. Two models exist, so the
 * cache is bounded by construction.
 */
const sessionCache = new Map<AiModelId, Promise<AiSession>>();

/** Tear down cached sessions (worker teardown / editor unmount). */
export async function disposeAiSessions(): Promise<void> {
  const pending = [...sessionCache.values()];
  sessionCache.clear();
  for (const promise of pending) {
    try {
      await (await promise).dispose();
    } catch {
      // A session that failed to build has nothing to dispose.
    }
  }
}

async function getSession(
  spec: AiModelSpec,
  context: AiJobContext,
  sessionOptions?: AiSessionOptions
): Promise<AiSession> {
  const cached = sessionCache.get(spec.id);
  if (cached) return cached;

  const factory = context.sessionFactory ?? createOnnxSession;
  const promise = (async () => {
    // An injected factory (tests) brings its own model — nothing to fetch.
    const bytes = context.sessionFactory
      ? new ArrayBuffer(0)
      : await loadModelBytes(spec, {
          signal: context.signal,
          onProgress: (loaded, total) => {
            const fraction = total ? Math.min(1, loaded / total) : 0;
            context.onProgress(
              0.05 + fraction * 0.55,
              total
                ? `מוריד את המודל (${formatModelSize(loaded)} מתוך ${formatModelSize(total)})`
                : `מוריד את המודל (${formatModelSize(loaded)})`
            );
          },
        });
    context.throwIfCancelled();
    context.onProgress(0.62, "טוען את המודל");
    try {
      return await factory(bytes, sessionOptions);
    } catch (err) {
      // A cached file the runtime refuses would otherwise fail forever; drop
      // it so the next attempt re-downloads.
      await evictCachedModel(spec);
      throw err;
    }
  })();
  sessionCache.set(spec.id, promise);
  promise.catch(() => sessionCache.delete(spec.id));
  return promise;
}

function validatePayload(payload: AiImagePayload): void {
  const { rgba, width, height } = payload;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2 ||
    width > 8192 ||
    height > 8192 ||
    rgba.length !== width * height * 4
  ) {
    throw new AiError("תמונת הקלט למודל אינה תקינה — נסו לייבא מחדש");
  }
}

async function runModel(
  modelId: AiModelId,
  payload: AiImagePayload,
  context: AiJobContext
): Promise<AiInferenceResult> {
  validatePayload(payload);
  const spec = AI_MODELS[modelId];
  let session = await getSession(spec, context);
  context.throwIfCancelled();

  context.onProgress(0.7, "מכין את התמונה");
  const tensor = rgbaToChwTensor(
    { width: payload.width, height: payload.height, data: payload.rgba },
    spec.inputSize,
    spec.mean,
    spec.std
  );
  context.throwIfCancelled();

  context.onProgress(0.75, "מריץ את המודל");
  const inputDims = [1, 3, spec.inputSize, spec.inputSize];
  let output;
  try {
    output = await session.run(tensor, inputDims);
  } catch (err) {
    if (err instanceof AiError) throw err;
    // A WebGPU session can be created successfully and still fail on its
    // FIRST run — driver and op-coverage problems only surface at inference.
    // That must not strand the user (the broken session was cached): rebuild
    // on WASM, retry once, and let the honest engine report say WASM ran.
    if (session.provider === "webgpu") {
      context.onProgress(0.75, "מנוע WebGPU נכשל — עובר ל-WASM");
      sessionCache.delete(spec.id);
      await session.dispose().catch(() => undefined);
      session = await getSession(spec, context, { providers: ["wasm"] });
      context.throwIfCancelled();
      try {
        output = await session.run(tensor, inputDims);
      } catch (retryErr) {
        if (retryErr instanceof AiError) throw retryErr;
        throw new AiError("הרצת מודל ה-AI נכשלה — נסו שוב או עברו למצב הקלאסי");
      }
    } else {
      throw new AiError("הרצת מודל ה-AI נכשלה — נסו שוב או עברו למצב הקלאסי");
    }
  }
  context.throwIfCancelled();

  // Both models put the map in the last two dims ([1,1,H,W] or [1,H,W]).
  const dims = output.dims;
  const height = dims[dims.length - 2];
  const width = dims[dims.length - 1];
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2 ||
    output.data.length < width * height
  ) {
    throw new AiError("פלט מודל ה-AI אינו כצפוי — בדקו את כתובת המודל המוגדרת");
  }
  const map = output.data.slice(0, width * height);
  const hasSignal = minMaxNormalize(map);
  context.onProgress(1, "הושלם");
  return { map, width, height, provider: session.provider, hasSignal };
}

type AiJobHandler<K extends AiJobName> = (
  payload: AiJobMap[K]["payload"],
  context: AiJobContext
) => Promise<AiJobMap[K]["result"]>;

const AI_JOB_HANDLERS: { [K in AiJobName]: AiJobHandler<K> } = {
  segmentImage: (payload, context) => runModel("segmentation", payload, context),
  estimateDepth: (payload, context) => runModel("depth", payload, context),
};

/** Run an AI job on the current thread (the worker AND the fallback path). */
export async function executeAiJob<K extends AiJobName>(
  name: K,
  payload: AiJobMap[K]["payload"],
  context: AiJobContext
): Promise<AiJobMap[K]["result"]> {
  const handler = AI_JOB_HANDLERS[name] as AiJobHandler<K>;
  if (!handler) throw new Error(`Unknown AI job: ${name}`);
  return handler(payload, context);
}
