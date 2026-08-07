/**
 * Bounded history + mesh retention (V6 item 3).
 *
 * The claim under test is a MEMORY outcome, not a call: after more
 * operations than the cap, (a) the history depth is bounded at
 * HISTORY_CAPACITY, and (b) the meshes referenced ONLY by the trimmed
 * steps are actually gone from the store — counted in bytes.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { DesignDocument, EditorHistoryState, ImportedMeshLayer } from "@/types/design";
import { createHistory, HISTORY_CAPACITY, pushHistory, undo } from "../history";
import { sweepUnreferencedMeshes } from "../retention";
import {
  clearMeshStore,
  hasMesh,
  meshStoreStats,
  storeMesh,
} from "@/lib/geometry/meshStore";
import type { MeshData } from "@/lib/geometry/meshData";

/** A tiny distinct mesh payload (one triangle; 60 bytes total). */
function tinyMesh(seed: number): MeshData {
  return {
    positions: new Float32Array([seed, 0, 0, seed + 1, 0, 0, seed, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
  };
}

function docWithMesh(meshId: string): DesignDocument {
  const layer: ImportedMeshLayer = {
    id: `layer_${meshId}`,
    type: "importedMesh",
    name: meshId,
    visible: true,
    locked: false,
    materialSlotId: "slot1",
    transform: {
      x: 0, y: 0, z: 0,
      rotationX: 0, rotationY: 0, rotationZ: 0,
      scaleX: 1, scaleY: 1, scaleZ: 1,
    },
    previewOpacity: 1,
    meshId,
    originalMeshId: meshId,
    provenance: { kind: "stlImport", fileName: `${meshId}.stl` },
    combine: "standalone",
  };
  return {
    version: 3,
    baseMode: "baseless",
    layers: [layer],
    materialSlots: [{ id: "slot1", nameHe: "חומר", colorHex: "#2f6feb" }],
    printabilityProfileId: "fdm-pla",
    usageProfileId: "decor",
  } as unknown as DesignDocument;
}

describe("bounded history retention", () => {
  beforeEach(() => clearMeshStore());

  it("caps the depth and actually frees the trimmed steps' meshes", () => {
    // 60 "operations": each stores a fresh mesh and pushes a state whose
    // document references it — the worst case the cap exists for.
    const meshIds: string[] = [];
    let state: EditorHistoryState | null = null;
    for (let i = 0; i < 60; i++) {
      const meshId = storeMesh(tinyMesh(i), `mesh_${i}`);
      meshIds.push(meshId);
      const document = docWithMesh(meshId);
      state = state
        ? pushHistory(state, document, `פעולה ${i}`)
        : createHistory(document);
    }
    if (!state) throw new Error("state not built");

    // (a) depth is bounded at the documented constant.
    expect(HISTORY_CAPACITY).toBe(50);
    expect(state.past.length).toBe(HISTORY_CAPACITY);

    const before = meshStoreStats();
    expect(before.count).toBe(60);

    // (b) the sweep frees exactly the meshes only trimmed entries held:
    // 60 states, present + 50 past = 51 reachable, 9 trimmed.
    const result = sweepUnreferencedMeshes(state);
    expect(result.removed).toBe(9);
    for (let i = 0; i < 9; i++) expect(hasMesh(`mesh_${i}`)).toBe(false);
    for (let i = 9; i < 60; i++) expect(hasMesh(`mesh_${i}`)).toBe(true);

    // Freed in bytes, not just in count.
    const after = meshStoreStats();
    expect(after.bytes).toBe(before.bytes - result.freedBytes);
    expect(result.freedBytes).toBe(9 * (9 * 4 + 3 * 4));

    // Undo still works across the whole retained range: the oldest retained
    // state's mesh must still resolve.
    let cursor = state;
    for (let i = 0; i < HISTORY_CAPACITY; i++) cursor = undo(cursor);
    const oldest = cursor.present.document.layers[0] as ImportedMeshLayer;
    expect(hasMesh(oldest.meshId)).toBe(true);
  });

  it("keeps a pending (uncommitted) mesh passed as an extra root", () => {
    const committed = storeMesh(tinyMesh(1), "mesh_committed");
    const pending = storeMesh(tinyMesh(2), "mesh_pending");
    const state = createHistory(docWithMesh(committed));

    const result = sweepUnreferencedMeshes(state, [pending]);
    expect(result.removed).toBe(0);
    expect(hasMesh(pending)).toBe(true);

    // Without the extra root the pending mesh is exactly what gets swept.
    const swept = sweepUnreferencedMeshes(state);
    expect(swept.removed).toBe(1);
    expect(hasMesh(pending)).toBe(false);
  });
});
