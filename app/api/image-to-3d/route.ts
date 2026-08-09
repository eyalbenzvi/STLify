/**
 * /api/image-to-3d — the image→3D proxy.
 *
 * GET: availability (is a provider configured, and which). POST: upload an
 * image, create a generation task, answer with an OPAQUE task id. All the
 * logic and its trust boundaries live in lib/server/imageTo3d.ts; the API
 * key never leaves the server.
 */

import { providerFromEnv } from "@/lib/ai/providers";
import { handleAvailability, handleCreateTask } from "@/lib/server/imageTo3d";

export function GET(): Response {
  return handleAvailability(providerFromEnv());
}

export function POST(request: Request): Promise<Response> {
  return handleCreateTask(request, providerFromEnv());
}
