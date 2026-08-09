/**
 * Provider selection from server environment (server-side only).
 *
 * The API key lives EXCLUSIVELY in IMAGE_TO_3D_API_KEY — a server env var
 * with no NEXT_PUBLIC_ prefix, so it can never be bundled to the client.
 * A missing key is a supported state: the availability endpoint reports it
 * and the UI disables the cloud mode with an explanation, never a crash.
 */

import { createMeshyProvider } from "./meshy";
import type { MeshGenProvider } from "./types";

export function providerFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch
): MeshGenProvider | null {
  const apiKey = env.IMAGE_TO_3D_API_KEY?.trim();
  if (!apiKey) return null;
  const name = (env.IMAGE_TO_3D_PROVIDER ?? "meshy").trim().toLowerCase();
  if (name === "meshy") return createMeshyProvider(apiKey, fetchImpl);
  // An unknown provider name is a configuration error; behaving like "no
  // provider" (mode disabled, reason shown) beats a runtime crash.
  return null;
}

export { ProviderError } from "./types";
export type { MeshGenProvider, ProviderTaskState, ProviderErrorKind } from "./types";
