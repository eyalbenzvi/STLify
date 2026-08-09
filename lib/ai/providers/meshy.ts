/**
 * Meshy image-to-3D provider (https://docs.meshy.ai, OpenAPI v1).
 *
 * Chosen over Tripo3D because a finished Meshy task carries an OBJ URL
 * directly (`model_urls.obj`), so the result enters through the existing
 * hardened OBJ importer and no GLB reader exists in this codebase at all —
 * the deciding criterion. Texturing is explicitly disabled: geometry only.
 *
 * The fetch implementation is injected so the task lifecycle, error and
 * timeout paths are all unit-testable without a network.
 */

import {
  ProviderError,
  type MeshGenProvider,
  type ProviderTaskState,
} from "./types";

const MESHY_BASE = "https://api.meshy.ai/openapi/v1/image-to-3d";

/** Meshy task ids are opaque; constrain them before they enter a URL. */
const MESHY_TASK_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

interface MeshyTaskResponse {
  id?: string;
  status?: string;
  progress?: number;
  model_urls?: { obj?: string };
  task_error?: { message?: string };
}

function errorForStatus(status: number, body: string): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError("auth", `Meshy rejected the API key (${status})`);
  }
  if (status === 402) {
    return new ProviderError("quota", "Meshy account is out of credits (402)");
  }
  if (status === 429) {
    return new ProviderError("rateLimited", "Meshy rate limit hit (429)");
  }
  if (status === 400 || status === 422) {
    return new ProviderError("invalidInput", `Meshy rejected the image (${status})`);
  }
  return new ProviderError("protocol", `Meshy answered ${status}: ${body.slice(0, 200)}`);
}

export function createMeshyProvider(
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): MeshGenProvider {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  const request = async (url: string, init?: RequestInit): Promise<MeshyTaskResponse> => {
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, headers });
    } catch {
      throw new ProviderError("network", "could not reach Meshy");
    }
    const body = await response.text();
    if (!response.ok) throw errorForStatus(response.status, body);
    try {
      return JSON.parse(body) as MeshyTaskResponse;
    } catch {
      throw new ProviderError("protocol", "Meshy answered with invalid JSON");
    }
  };

  return {
    id: "meshy",
    nameHe: "Meshy",
    modelHostAllowlist: [".meshy.ai"],

    async createTask(image) {
      const dataUri = `data:${image.mime};base64,${Buffer.from(image.bytes).toString("base64")}`;
      const body = JSON.stringify({
        image_url: dataUri,
        // Geometry only, by scope: no texture generation, no PBR maps.
        should_texture: false,
        enable_pbr: false,
        topology: "triangle",
      });
      const parsed = (await request(MESHY_BASE, { method: "POST", body })) as {
        result?: string;
      };
      const taskId = parsed.result;
      if (typeof taskId !== "string" || !MESHY_TASK_ID_RE.test(taskId)) {
        throw new ProviderError("protocol", "Meshy did not return a task id");
      }
      return taskId;
    },

    async getTask(providerTaskId) {
      if (!MESHY_TASK_ID_RE.test(providerTaskId)) {
        throw new ProviderError("protocol", "invalid Meshy task id");
      }
      const task = await request(`${MESHY_BASE}/${providerTaskId}`);
      switch (task.status) {
        case "PENDING":
          return { state: "pending" } satisfies ProviderTaskState;
        case "IN_PROGRESS": {
          const progress = typeof task.progress === "number" ? task.progress / 100 : 0;
          return {
            state: "running",
            progress: Math.max(0, Math.min(1, progress)),
          } satisfies ProviderTaskState;
        }
        case "SUCCEEDED": {
          const modelUrl = task.model_urls?.obj;
          if (typeof modelUrl !== "string" || modelUrl.length === 0) {
            throw new ProviderError(
              "protocol",
              "Meshy task succeeded but returned no OBJ URL"
            );
          }
          return { state: "succeeded", modelUrl, format: "obj" } satisfies ProviderTaskState;
        }
        case "FAILED":
        case "CANCELED":
          return {
            state: "failed",
            reason: task.task_error?.message || task.status,
          } satisfies ProviderTaskState;
        default:
          throw new ProviderError(
            "protocol",
            `Meshy returned an unknown status: ${String(task.status)}`
          );
      }
    },
  };
}
