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

export type AiSessionFactory = (modelBytes: ArrayBuffer) => Promise<AiSession>;

/** Where the copied onnxruntime-web wasm artifacts are served from. */
const ORT_WASM_BASE = "/ort/";

/** Create a real onnxruntime-web session over the given model bytes. */
export const createOnnxSession: AiSessionFactory = async (modelBytes) => {
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

  let session: import("onnxruntime-web").InferenceSession;
  let provider: AiExecutionProvider;
  try {
    if (webGpuAvailable) {
      try {
        session = await tryCreate("webgpu");
        provider = "webgpu";
      } catch {
        session = await tryCreate("wasm");
        provider = "wasm";
      }
    } else {
      session = await tryCreate("wasm");
      provider = "wasm";
    }
  } catch {
    throw new AiError(
      "הפעלת מנוע ה-AI נכשלה בדפדפן זה — ייתכן שקובץ המודל פגום או שהדפדפן אינו נתמך"
    );
  }

  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  if (!inputName || !outputName) {
    await session.release().catch(() => undefined);
    throw new AiError("מבנה מודל ה-AI אינו כצפוי — בדקו את כתובת המודל המוגדרת");
  }

  return {
    provider,
    async run(input, dims) {
      const feeds: Record<string, import("onnxruntime-web").Tensor> = {
        [inputName]: new ort.Tensor("float32", input, dims as number[]),
      };
      const results = await session.run(feeds);
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
      await session.release().catch(() => undefined);
    },
  };
};
