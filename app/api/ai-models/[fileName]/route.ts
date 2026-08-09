/**
 * /api/ai-models/[fileName] — same-origin download for the on-device AI
 * model weights (GitHub's release assets send no CORS headers, so the
 * browser cannot fetch them directly). Only registered file names are
 * served; see lib/server/aiModelProxy.ts.
 */

import { handleModelDownload } from "@/lib/server/aiModelProxy";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ fileName: string }> }
): Promise<Response> {
  const { fileName } = await params;
  return handleModelDownload(fileName);
}
