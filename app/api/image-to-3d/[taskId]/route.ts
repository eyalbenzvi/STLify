/** /api/image-to-3d/[taskId] — poll a generation task's state. */

import { providerFromEnv } from "@/lib/ai/providers";
import { handleTaskStatus } from "@/lib/server/imageTo3d";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ taskId: string }> }
): Promise<Response> {
  const { taskId } = await params;
  return handleTaskStatus(request, taskId, providerFromEnv());
}
