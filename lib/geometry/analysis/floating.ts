/**
 * Floating-component analysis: finds disconnected pieces of a part that
 * hover above the build plate (they would print in mid-air).
 */

import type { ModelIssue } from "@/types/design";
import type { MeshData } from "../meshData";
import { UnionFind } from "./meshMath";

export interface ComponentInfo {
  triangleCount: number;
  minZ: number;
  bounds: {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  };
}

export interface FloatingAnalysis {
  componentCount: number;
  components: ComponentInfo[];
  floatingCount: number;
  issues: ModelIssue[];
}

export function analyzeFloatingParts(
  mesh: MeshData,
  opts?: { liftToleranceMm?: number }
): FloatingAnalysis {
  const lift = opts?.liftToleranceMm ?? 0.5;
  const vertexCount = mesh.positions.length / 3;
  const uf = new UnionFind(vertexCount);
  for (let i = 0; i < mesh.indices.length; i += 3) {
    uf.union(mesh.indices[i], mesh.indices[i + 1]);
    uf.union(mesh.indices[i + 1], mesh.indices[i + 2]);
  }

  const byRoot = new Map<number, ComponentInfo>();
  const p = mesh.positions;
  for (let t = 0; t < mesh.indices.length / 3; t++) {
    const root = uf.find(mesh.indices[t * 3]);
    let info = byRoot.get(root);
    if (!info) {
      info = {
        triangleCount: 0,
        minZ: Infinity,
        bounds: {
          min: { x: Infinity, y: Infinity, z: Infinity },
          max: { x: -Infinity, y: -Infinity, z: -Infinity },
        },
      };
      byRoot.set(root, info);
    }
    info.triangleCount++;
    for (let v = 0; v < 3; v++) {
      const base = mesh.indices[t * 3 + v] * 3;
      const x = p[base],
        y = p[base + 1],
        z = p[base + 2];
      info.bounds.min.x = Math.min(info.bounds.min.x, x);
      info.bounds.min.y = Math.min(info.bounds.min.y, y);
      info.bounds.min.z = Math.min(info.bounds.min.z, z);
      info.bounds.max.x = Math.max(info.bounds.max.x, x);
      info.bounds.max.y = Math.max(info.bounds.max.y, y);
      info.bounds.max.z = Math.max(info.bounds.max.z, z);
      info.minZ = Math.min(info.minZ, z);
    }
  }

  const components = [...byRoot.values()];
  const globalMinZ = Math.min(...components.map((c) => c.minZ), Infinity);
  const floating = components.filter((c) => c.minZ > globalMinZ + lift);

  const issues: ModelIssue[] = [];
  if (floating.length > 0) {
    const sample = floating[0];
    issues.push({
      code: "floating/components",
      severity: "warning",
      titleHe: `${floating.length} רכיבים מרחפים באוויר`,
      detailHe:
        "חלקים שאינם מחוברים לגוף וגם אינם נוגעים במשטח יודפסו באוויר וייכשלו ללא תמיכות",
      actionHe: "הורידו אותם למשטח, חברו אותם לגוף או הסירו אותם",
      location: {
        x: (sample.bounds.min.x + sample.bounds.max.x) / 2,
        y: (sample.bounds.min.y + sample.bounds.max.y) / 2,
        z: (sample.bounds.min.z + sample.bounds.max.z) / 2,
      },
    });
  }

  return {
    componentCount: components.length,
    components,
    floatingCount: floating.length,
    issues,
  };
}
