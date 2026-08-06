/**
 * Share-link tests: round trip through deflate + base64url hash, size
 * limits, and eligibility rules.
 */

import { describe, expect, it } from "vitest";
import { identityTransform, newId } from "@/types/design";
import { createTemplateDocument, emptyDocument } from "@/lib/geometry/documentTemplates";
import { storeMesh } from "@/lib/geometry/meshStore";
import {
  decodeShareHash,
  encodeShareHash,
  SHARE_HASH_PREFIX,
  shareLinkEligibility,
} from "../shareLink";

describe("share links", () => {
  it("round-trips a template document through the hash", async () => {
    const doc = createTemplateDocument("keychain");
    const hash = await encodeShareHash(doc);
    expect(hash).not.toBeNull();
    expect(hash!.startsWith(SHARE_HASH_PREFIX)).toBe(true);
    const { document, warningsHe } = await decodeShareHash(hash!);
    expect(warningsHe.length).toBe(0);
    expect(document.baseMode).toBe("withBase");
    expect(document.layers.length).toBe(doc.layers.length);
    const text = document.layers.find((l) => l.type === "text");
    if (text && text.type === "text") expect(text.content).toBe("אייל");
  });

  it("rejects designs with imported meshes", () => {
    const doc = emptyDocument();
    const meshId = storeMesh({
      positions: new Float32Array([0, 0, 0]),
      indices: new Uint32Array([0, 0, 0]),
    });
    doc.layers = [
      {
        id: newId("layer"),
        type: "importedMesh",
        name: "רשת",
        visible: true,
        locked: false,
        materialSlotId: "slot1",
        transform: identityTransform(),
        previewOpacity: 1,
        meshId,
        provenance: { kind: "stlImport" },
        originalMeshId: null,
        combine: "standalone",
      },
    ];
    const eligibility = shareLinkEligibility(doc);
    expect(eligibility.ok).toBe(false);
    if (!eligibility.ok) expect(eligibility.reasonHe).toContain("קובץ עיצוב");
  });

  it("rejects malformed hashes", async () => {
    await expect(decodeShareHash("#d=!!notbase64!!")).rejects.toThrow();
    await expect(decodeShareHash("#other")).rejects.toThrow();
  });
});
