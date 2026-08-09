/**
 * The ONLY module that touches onnxruntime-web.
 *
 * Everything else talks to the `AiSession` interface, which is what lets
 * unit tests inject fakes and the e2e suite stub inference entirely — the
 * runtime is dynamically imported, so no test and no server render ever
 * loads it.
 *
 * Execution provider: WebGPU when the browser exposes it, WASM otherwise.
 * The fallback is silent but honest — the provider that actually ran is on
 * the session and reported to the UI, the same contract as the geometry
 * worker's `ranOn`.
 */

import { AiError } from "./errors";

export type AiExecutionProvider = "webgpu" | "wasm";

export interface AiRunOutput {
  data: Float32Array;
  dims: readonly number[];
}

export interface AiSession {
  provider: AiExecutionProvider;
  /** Run the model's single image input; returns its first output. */
  run(input: Float32Array, dims: readonly number[]): Promise<AiRunOutput>;
  dispose(): Promise<void>;
}

export interface AiSessionOptions {
  /**
   * Execution providers to try, in order. Default: WebGPU when the browser
   * exposes it, then WASM. Callers pass ["wasm"] to force the fallback —
   * notably after a WebGPU session was created successfully but then failed
   * at RUN time, which real GPUs do (driver/op-coverage issues surface only
   * on first inference).
   */
  providers?: AiExecutionProvider[];
}

export type AiSessionFactory = (
  modelBytes: ArrayBuffer,
  options?: AiSessionOptions
) => Promise<AiSession>;

/** Where the copied onnxruntime-web wasm artifacts are served from. */
const ORT_WASM_BASE = "/ort/";

/** Create a real onnxruntime-web session over the given model bytes. */
export const createOnnxSession: AiSessionFactory = async (modelBytes, options) => {
  let ort: typeof import("onnxruntime-web");
  try {
    ort = await import("onnxruntime-web");
  } catch {
    throw new AiError("טעינת מנוע ה-AI נכשלה — רעננו את הדף ונסו שוב");
  }

  ort.env.wasm.wasmPaths = ORT_WASM_BASE;
  // The app is not cross-origin isolated, so threaded WASM cannot start;
  // pin one thread explicitly instead of relying on the silent downgrade.
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;

  const webGpuAvailable =
    typeof navigator !== "undefined" &&
    (navigator as { gpu?: unknown }).gpu !== undefined;

  const tryCreate = async (provider: AiExecutionProvider) =>
    ort.InferenceSession.create(new Uint8Array(modelBytes), {
      executionProviders: [provider],
    });

  const requested =
    options?.providers ?? (webGpuAvailable ? (["webgpu", "wasm"] as const) : (["wasm"] as const));

  let session: import("onnxruntime-web").InferenceSession | null = null;
  let provider: AiExecutionProvider = "wasm";
  for (const candidate of requested) {
    try {
      session = await tryCreate(candidate);
      provider = candidate;
      break;
    } catch {
      // Try the next provider; an empty list at the end is the real failure.
    }
  }
  if (!session) {
    throw new AiError(
      "הפעלת מנוע ה-AI נכשלה בדפדפן זה — ייתכן שקובץ המודל פגום או שהדפדפן אינו נתמך"
    );
  }

  const live = session;
  const inputName = live.inputNames[0];
  const outputName = live.outputNames[0];
  if (!inputName || !outputName) {
    await live.release().catch(() => undefined);
    throw new AiError("מבנה מודל ה-AI אינו כצפוי — בדקו את כתובת המודל המוגדרת");
  }

  return {
    provider,
    async run(input, dims) {
      const feeds: Record<string, import("onnxruntime-web").Tensor> = {
        [inputName]: new ort.Tensor("float32", input, dims as number[]),
      };
      const results = await live.run(feeds);
      const output = results[outputName];
      if (!output) {
        throw new AiError("הרצת מודל ה-AI לא החזירה תוצאה — נסו שוב");
      }
      const data = await output.getData();
      // WebGPU may hand back a GPU-resident tensor; getData() downloads it.
      const array =
        data instanceof Float32Array ? data : Float32Array.from(data as ArrayLike<number>);
      const dimsOut = [...output.dims];
      output.dispose?.();
      return { data: array, dims: dimsOut };
    },
    async dispose() {
      await live.release().catch(() => undefined);
    },
  };
};
