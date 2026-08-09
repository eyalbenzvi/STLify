/**
 * The image→3D provider abstraction (server-side only).
 *
 * Exactly one concrete provider ships (Meshy — see the comparison in
 * docs/AI-IMAGE-PLAN.md §4.1); the interface exists so a second one is a
 * new file rather than a refactor, and so tests can drive the proxy and the
 * client against a fake. Geometry only: textures/materials are neither
 * requested nor read.
 */

export type ProviderErrorKind =
  /** Key rejected — misconfigured server. */
  | "auth"
  /** Plan/credit exhaustion at the provider. */
  | "quota"
  /** Provider-side rate limiting. */
  | "rateLimited"
  /** The provider rejected the image itself. */
  | "invalidInput"
  /** Could not reach the provider. */
  | "network"
  /** The provider answered something the client does not understand. */
  | "protocol";

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export type ProviderTaskState =
  | { state: "pending" }
  | { state: "running"; progress: number /* 0..1 */ }
  | { state: "failed"; reason: string }
  | {
      state: "succeeded";
      /** Direct URL of the OBJ result on the provider's asset host. */
      modelUrl: string;
      format: "obj";
    };

export interface MeshGenProvider {
  readonly id: string;
  /** Named recipient for the consent notice. */
  readonly nameHe: string;
  /**
   * Host suffixes the model download is allowed to come from. The URL in a
   * task response is still external data; anything outside this list is
   * refused rather than fetched.
   */
  readonly modelHostAllowlist: readonly string[];
  createTask(image: { bytes: Uint8Array; mime: string }): Promise<string>;
  getTask(providerTaskId: string): Promise<ProviderTaskState>;
}
