/**
 * Copy the onnxruntime-web runtime artifacts into public/ort/.
 *
 * The AI features run ONNX models in the browser, and onnxruntime-web loads
 * its WASM backend by URL at runtime. Serving those files from our own
 * origin keeps the app's local-first promise (no CDN request just to run a
 * local model) and keeps the strict version coupling honest: the artifacts
 * are copied from the installed package on every dev/build, never vendored
 * by hand, so the JS API and the WASM binary cannot drift apart.
 *
 * public/ort/ is gitignored — it is a build product.
 */

import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "node_modules", "onnxruntime-web", "dist");
const target = join(root, "public", "ort");

mkdirSync(target, { recursive: true });

// The single-threaded and JSEP (WebGPU) runtimes, loader + binary for each.
const wanted = readdirSync(source).filter((name) =>
  /^ort-wasm-simd-threaded(\.jsep)?\.(wasm|mjs)$/.test(name)
);
if (wanted.length === 0) {
  console.error("copyOrtAssets: no onnxruntime-web runtime files found in", source);
  process.exit(1);
}
for (const name of wanted) copyFileSync(join(source, name), join(target, name));
console.log(`copyOrtAssets: copied ${wanted.length} files to public/ort/`);
