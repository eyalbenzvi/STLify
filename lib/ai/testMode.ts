/**
 * Deterministic fake inference for the e2e suite.
 *
 * The Playwright journeys must exercise the REAL downstream pipeline (grids,
 * mesher, kernel, document) without downloading 100 MB of weights or running
 * a neural network in CI. This is the mock boundary: when the flag below is
 * set in localStorage — which no production code ever does — the AI client
 * returns these shapes instead of touching the worker or the runtime.
 *
 * The shapes are chosen so a test can assert a GEOMETRY consequence:
 * - segmentation: a centred disk covering half the image's smaller side;
 * - depth: a radial gradient, nearest at the centre.
 */

import type { AiImagePayload, AiInferenceResult, AiJobName } from "./jobs";

export const AI_TEST_MODE_KEY = "stlify.aiTestMode";

export function aiTestModeEnabled(): boolean {
  try {
    return (
      typeof localStorage !== "undefined" && localStorage.getItem(AI_TEST_MODE_KEY) === "1"
    );
  } catch {
    return false;
  }
}

export function fakeAiResult(name: AiJobName, payload: AiImagePayload): AiInferenceResult {
  const size = 64;
  const map = new Float32Array(size * size);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const radius = size * 0.35;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cy);
      map[y * size + x] =
        name === "segmentImage"
          ? d <= radius
            ? 1
            : 0
          : Math.max(0, 1 - d / radius);
    }
  }
  void payload;
  return { map, width: size, height: size, provider: "wasm", hasSignal: true };
}
