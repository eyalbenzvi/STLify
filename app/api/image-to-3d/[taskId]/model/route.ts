/** /api/image-to-3d/[taskId]/model — download the finished OBJ (proxied). */

import { providerFromEnv } from "@/lib/ai/providers";
import { handleTaskModel } from "@/lib/server/imageTo3d";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ taskId: string }> }
): Promise<Response> {
  const { taskId } = await params;
  return handleTaskModel(request, taskId, providerFromEnv());
}
