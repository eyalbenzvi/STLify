/**
 * Geometry kernel abstraction.
 *
 * All solid-modelling operations (extrusion, booleans) go through this
 * interface so the underlying engine can be swapped without touching the
 * rest of the pipeline.
 *
 * Current engine: Manifold (manifold-3d, WASM). Manifold is a
 * guaranteed-manifold kernel: every boolean result is a watertight,
 * self-intersection-free solid, which is exactly what slicers need.
 * 2D contours are resolved with the NonZero fill rule (Clipper2), which
 * also robustly handles overlapping font-glyph outlines.
 *
 * Memory model: WASM objects are not garbage-collected. Operations that
 * return a new Solid CONSUME their inputs (they are freed automatically);
 * call dispose() on any solid you abandon without consuming.
 */

import * as THREE from "three";
import type { Manifold, ManifoldToplevel } from "manifold-3d";

/** A 2D point as [x, y], in mm. */
export type Vec2Tuple = [number, number];

/** A closed 2D contour (implicitly closed; no repeated end point needed). */
export type Contour = Vec2Tuple[];

/** An opaque solid handle produced by the kernel. */
export interface Solid {
  /** Translate in mm. Consumes this solid and returns a new one. */
  translate(x: number, y: number, z: number): Solid;
  /** Boolean union. Consumes both operands. */
  union(other: Solid): Solid;
  /** Boolean difference (this minus other). Consumes both operands. */
  subtract(other: Solid): Solid;
  /** True when the solid contains no geometry. */
  isEmpty(): boolean;
  /** Convert to an indexed three.js geometry. Does not consume the solid. */
  toGeometry(): THREE.BufferGeometry;
  /** Free the underlying WASM memory. */
  dispose(): void;
}

export interface GeometryKernel {
  /**
   * Extrude closed 2D contours (NonZero fill rule, so overlapping contours
   * merge and opposite-winding contours become holes) into a solid spanning
   * z in [0, heightMm].
   */
  extrude(contours: Contour[], heightMm: number): Solid;
  /** A cylinder of the given radius spanning z in [0, heightMm]. */
  cylinder(radiusMm: number, heightMm: number, segments?: number): Solid;
}

class ManifoldSolid implements Solid {
  constructor(private manifold: Manifold) {}

  translate(x: number, y: number, z: number): Solid {
    const next = this.manifold.translate(x, y, z);
    this.manifold.delete();
    return new ManifoldSolid(next);
  }

  union(other: Solid): Solid {
    const b = (other as ManifoldSolid).manifold;
    const next = this.manifold.add(b);
    this.manifold.delete();
    b.delete();
    return new ManifoldSolid(next);
  }

  subtract(other: Solid): Solid {
    const b = (other as ManifoldSolid).manifold;
    const next = this.manifold.subtract(b);
    this.manifold.delete();
    b.delete();
    return new ManifoldSolid(next);
  }

  isEmpty(): boolean {
    return this.manifold.isEmpty();
  }

  toGeometry(): THREE.BufferGeometry {
    const mesh = this.manifold.getMesh();
    const geometry = new THREE.BufferGeometry();
    if (mesh.numProp === 3) {
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(mesh.vertProperties, 3)
      );
    } else {
      // Positions are the first three properties of each vertex.
      const count = mesh.vertProperties.length / mesh.numProp;
      const positions = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        positions[i * 3] = mesh.vertProperties[i * mesh.numProp];
        positions[i * 3 + 1] = mesh.vertProperties[i * mesh.numProp + 1];
        positions[i * 3 + 2] = mesh.vertProperties[i * mesh.numProp + 2];
      }
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    }
    geometry.setIndex(new THREE.BufferAttribute(mesh.triVerts, 1));
    geometry.computeVertexNormals();
    return geometry;
  }

  dispose(): void {
    this.manifold.delete();
  }
}

class ManifoldKernel implements GeometryKernel {
  constructor(private wasm: ManifoldToplevel) {}

  extrude(contours: Contour[], heightMm: number): Solid {
    const { CrossSection, Manifold } = this.wasm;
    const section = new CrossSection(contours, "NonZero");
    const solid = Manifold.extrude(section, heightMm);
    section.delete();
    return new ManifoldSolid(solid);
  }

  cylinder(radiusMm: number, heightMm: number, segments = 64): Solid {
    const { Manifold } = this.wasm;
    return new ManifoldSolid(
      Manifold.cylinder(heightMm, radiusMm, radiusMm, segments)
    );
  }
}

let kernelPromise: Promise<GeometryKernel> | null = null;

/** Get the shared kernel instance (loads the WASM module on first call). */
export function getGeometryKernel(): Promise<GeometryKernel> {
  if (!kernelPromise) {
    kernelPromise = import("manifold-3d")
      .then((mod) => mod.default())
      .then((wasm) => {
        wasm.setup();
        return new ManifoldKernel(wasm);
      });
    // Allow retrying if the WASM module fails to load.
    kernelPromise.catch(() => {
      kernelPromise = null;
    });
  }
  return kernelPromise;
}
