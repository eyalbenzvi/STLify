/**
 * Geometry kernel abstraction.
 *
 * All solid-modelling operations (extrusion, booleans, transforms) go
 * through this interface so the underlying engine can be swapped without
 * touching the rest of the pipeline.
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
import type { FillRule, Manifold, ManifoldToplevel } from "manifold-3d";

/** A 2D point as [x, y], in mm. */
export type Vec2Tuple = [number, number];

/** A closed 2D contour (implicitly closed; no repeated end point needed). */
export type Contour = Vec2Tuple[];

/** Raw indexed-mesh arrays (positions xyz interleaved, CCW triangles). */
export interface MeshArrays {
  vertProperties: Float32Array;
  triVerts: Uint32Array;
}

/** An opaque solid handle produced by the kernel. */
export interface Solid {
  /** Translate in mm. Consumes this solid and returns a new one. */
  translate(x: number, y: number, z: number): Solid;
  /** Rotate by degrees around X, then Y, then Z. Consumes this solid. */
  rotate(xDeg: number, yDeg: number, zDeg: number): Solid;
  /** Non-uniform scale. Consumes this solid. */
  scale(x: number, y: number, z: number): Solid;
  /** Boolean union. Consumes both operands. */
  union(other: Solid): Solid;
  /** Boolean difference (this minus other). Consumes both operands. */
  subtract(other: Solid): Solid;
  /** Boolean intersection. Consumes both operands. */
  intersect(other: Solid): Solid;
  /** An independent copy (does NOT consume this solid). */
  clone(): Solid;
  /** True when the solid contains no geometry. */
  isEmpty(): boolean;
  /** Enclosed volume in mm³. Does not consume the solid. */
  volume(): number;
  /** Surface area in mm². Does not consume the solid. */
  surfaceArea(): number;
  /** Triangle count. Does not consume the solid. */
  triangleCount(): number;
  /** Number of topologically disconnected components. Does not consume. */
  componentCount(): number;
  /** Axis-aligned bounding box in mm. Does not consume the solid. */
  boundingBox(): { min: [number, number, number]; max: [number, number, number] };
  /** Convert to an indexed three.js geometry. Does not consume the solid. */
  toGeometry(): THREE.BufferGeometry;
  /** Free the underlying WASM memory. */
  dispose(): void;
}

export interface GeometryKernel {
  /**
   * Extrude closed 2D contours into a solid spanning z in [0, heightMm].
   * The default NonZero fill rule merges overlapping contours and turns
   * opposite-winding contours into holes.
   */
  extrude(contours: Contour[], heightMm: number, fillRule?: FillRule): Solid;
  /** A cylinder of the given radius spanning z in [0, heightMm]. */
  cylinder(radiusMm: number, heightMm: number, segments?: number): Solid;
  /**
   * A rim/frame: the area between the contours and the same contours inset
   * by insetMm, extruded to heightMm. Empty when the inset consumes the shape.
   */
  ring(contours: Contour[], heightMm: number, insetMm: number): Solid;
  /** Offset (grow > 0 / shrink < 0) contours in 2D. Rounded joins. */
  offsetContours(contours: Contour[], deltaMm: number, fillRule?: FillRule): Contour[];
  /**
   * Build a solid from raw indexed-mesh arrays. The mesh must describe a
   * closed 2-manifold; throws when Manifold rejects it.
   */
  fromMeshArrays(mesh: MeshArrays): Solid;
  /** Union many solids at once (consumes all inputs). */
  unionAll(solids: Solid[]): Solid;
}

class ManifoldSolid implements Solid {
  constructor(
    private manifold: Manifold,
    private wasm: ManifoldToplevel
  ) {}

  private wrap(next: Manifold): Solid {
    this.manifold.delete();
    return new ManifoldSolid(next, this.wasm);
  }

  translate(x: number, y: number, z: number): Solid {
    return this.wrap(this.manifold.translate(x, y, z));
  }

  rotate(xDeg: number, yDeg: number, zDeg: number): Solid {
    if (xDeg === 0 && yDeg === 0 && zDeg === 0) return this;
    return this.wrap(this.manifold.rotate(xDeg, yDeg, zDeg));
  }

  scale(x: number, y: number, z: number): Solid {
    if (x === 1 && y === 1 && z === 1) return this;
    return this.wrap(this.manifold.scale([x, y, z]));
  }

  union(other: Solid): Solid {
    const b = (other as ManifoldSolid).manifold;
    const next = this.manifold.add(b);
    this.manifold.delete();
    b.delete();
    return new ManifoldSolid(next, this.wasm);
  }

  subtract(other: Solid): Solid {
    const b = (other as ManifoldSolid).manifold;
    const next = this.manifold.subtract(b);
    this.manifold.delete();
    b.delete();
    return new ManifoldSolid(next, this.wasm);
  }

  intersect(other: Solid): Solid {
    const b = (other as ManifoldSolid).manifold;
    const next = this.manifold.intersect(b);
    this.manifold.delete();
    b.delete();
    return new ManifoldSolid(next, this.wasm);
  }

  clone(): Solid {
    // A zero translation produces an independent handle to the same solid.
    return new ManifoldSolid(this.manifold.translate(0, 0, 0), this.wasm);
  }

  isEmpty(): boolean {
    return this.manifold.isEmpty();
  }

  volume(): number {
    return this.manifold.volume();
  }

  surfaceArea(): number {
    return this.manifold.surfaceArea();
  }

  triangleCount(): number {
    return this.manifold.numTri();
  }

  componentCount(): number {
    const parts = this.manifold.decompose();
    const count = parts.length;
    for (const part of parts) part.delete();
    return count;
  }

  boundingBox(): { min: [number, number, number]; max: [number, number, number] } {
    const box = this.manifold.boundingBox();
    return { min: [...box.min], max: [...box.max] };
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

  extrude(contours: Contour[], heightMm: number, fillRule: FillRule = "NonZero"): Solid {
    const { CrossSection, Manifold } = this.wasm;
    const section = new CrossSection(contours, fillRule);
    const solid = Manifold.extrude(section, heightMm);
    section.delete();
    return new ManifoldSolid(solid, this.wasm);
  }

  cylinder(radiusMm: number, heightMm: number, segments = 64): Solid {
    const { Manifold } = this.wasm;
    return new ManifoldSolid(
      Manifold.cylinder(heightMm, radiusMm, radiusMm, segments),
      this.wasm
    );
  }

  ring(contours: Contour[], heightMm: number, insetMm: number): Solid {
    const { CrossSection, Manifold } = this.wasm;
    const outer = new CrossSection(contours, "NonZero");
    const inner = outer.offset(-Math.abs(insetMm), "Round");
    const ringSection = outer.subtract(inner);
    const solid = Manifold.extrude(ringSection, heightMm);
    outer.delete();
    inner.delete();
    ringSection.delete();
    return new ManifoldSolid(solid, this.wasm);
  }

  offsetContours(
    contours: Contour[],
    deltaMm: number,
    fillRule: FillRule = "NonZero"
  ): Contour[] {
    const { CrossSection } = this.wasm;
    const section = new CrossSection(contours, fillRule);
    const offset = section.offset(deltaMm, "Round");
    const polygons = offset.toPolygons();
    section.delete();
    offset.delete();
    return polygons.map((poly) => poly.map((p): Vec2Tuple => [p[0], p[1]]));
  }

  fromMeshArrays(meshArrays: MeshArrays): Solid {
    const { Mesh, Manifold } = this.wasm;
    const mesh = new Mesh({
      numProp: 3,
      vertProperties: meshArrays.vertProperties,
      triVerts: meshArrays.triVerts,
    });
    mesh.merge();
    const manifold = Manifold.ofMesh(mesh);
    const solid = new ManifoldSolid(manifold, this.wasm);
    if (solid.isEmpty()) {
      solid.dispose();
      throw new Error("Mesh could not be converted to a manifold solid");
    }
    return solid;
  }

  unionAll(solids: Solid[]): Solid {
    if (solids.length === 0) throw new Error("unionAll requires at least one solid");
    let result = solids[0];
    for (let i = 1; i < solids.length; i++) {
      result = result.union(solids[i]);
    }
    return result;
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
