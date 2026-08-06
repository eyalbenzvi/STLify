/**
 * Geometry kernel abstraction.
 *
 * All solid-modelling operations (extrusion, booleans, cuts, hollowing
 * primitives, simplification) go through this interface so the underlying
 * engine can be swapped without touching the rest of the pipeline.
 *
 * Current engine: Manifold (manifold-3d, WASM). Manifold is a
 * guaranteed-manifold kernel: every boolean result is a watertight,
 * self-intersection-free solid, which is exactly what slicers need.
 * 2D contours are resolved with the NonZero fill rule (Clipper2), which
 * also robustly handles overlapping font-glyph outlines.
 *
 * Memory model: WASM objects are not garbage-collected. Operations that
 * return a new Solid CONSUME their inputs (they are freed automatically)
 * unless documented otherwise; call dispose() on any solid you abandon
 * without consuming. Use duplicate() to keep a handle across a consuming
 * call.
 */

import * as THREE from "three";
import type { Manifold, ManifoldToplevel } from "manifold-3d";
import type { MeshData } from "./meshData";

/** A 2D point as [x, y], in mm. */
export type Vec2Tuple = [number, number];

/** A closed 2D contour (implicitly closed; no repeated end point needed). */
export type Contour = Vec2Tuple[];

export interface SolidBounds {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

export interface SolidRayHit {
  distance: number;
  position: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
}

/** An opaque solid handle produced by the kernel. */
export interface Solid {
  /** Translate in mm. Consumes this solid and returns a new one. */
  translate(x: number, y: number, z: number): Solid;
  /** Rotate around X, then Y, then Z (degrees). Consumes this solid. */
  rotate(xDeg: number, yDeg: number, zDeg: number): Solid;
  /** Per-axis scale. Consumes this solid. */
  scale(x: number, y: number, z: number): Solid;
  /** Mirror over the plane through the origin with this normal. Consumes. */
  mirror(nx: number, ny: number, nz: number): Solid;
  /** Apply a column-major 4x4 matrix (three.js layout). Consumes. */
  transform(mat4ColumnMajor: number[]): Solid;
  /** Boolean union. Consumes both operands. */
  union(other: Solid): Solid;
  /** Boolean difference (this minus other). Consumes both operands. */
  subtract(other: Solid): Solid;
  /** Boolean intersection. Consumes both operands. */
  intersect(other: Solid): Solid;
  /**
   * Cut by the plane { p · normal = offset }. Returns [above, below] —
   * both sides are closed (capped) solids. Consumes this solid.
   */
  splitByPlane(nx: number, ny: number, nz: number, offsetMm: number): [Solid, Solid];
  /** Keep only the side above the plane (capped). Consumes this solid. */
  trimByPlane(nx: number, ny: number, nz: number, offsetMm: number): Solid;
  /** Closed polygons of the cross-section at height z. Does NOT consume. */
  slicePolygons(z: number): Contour[];
  /** Split into topologically disconnected parts. Consumes this solid. */
  decompose(): Solid[];
  /** Edge-collapse simplification with tolerance in mm. Consumes. */
  simplify(toleranceMm: number): Solid;
  /** Convex hull. Consumes this solid. */
  hull(): Solid;
  /** Morphological dilation by another solid. Consumes both. EXPENSIVE. */
  minkowskiSum(other: Solid): Solid;
  /** Morphological erosion by another solid. Consumes both. EXPENSIVE. */
  minkowskiDifference(other: Solid): Solid;
  /** A second independent handle to the same solid. Does NOT consume. */
  duplicate(): Solid;
  /** True when the solid contains no geometry. */
  isEmpty(): boolean;
  /** Kernel status ("NoError" when the solid is valid). */
  status(): string;
  numTriangles(): number;
  /** Topological genus (number of handles). Meaningful per-component. */
  genus(): number;
  volumeMm3(): number;
  surfaceAreaMm2(): number;
  boundingBox(): SolidBounds;
  /** All ray-segment hits sorted by distance. Does NOT consume. */
  rayCast(
    origin: { x: number; y: number; z: number },
    end: { x: number; y: number; z: number }
  ): SolidRayHit[];
  /** Convert to an indexed three.js geometry. Does not consume the solid. */
  toGeometry(): THREE.BufferGeometry;
  /** Convert to transferable mesh data. Does not consume the solid. */
  toMeshData(): MeshData;
  /** Free the underlying WASM memory. */
  dispose(): void;
}

export type ContourJoin = "round" | "miter" | "square";

export interface GeometryKernel {
  /**
   * Extrude closed 2D contours (NonZero fill rule, so overlapping contours
   * merge and opposite-winding contours become holes) into a solid spanning
   * z in [0, heightMm].
   */
  extrude(contours: Contour[], heightMm: number): Solid;
  /** A cylinder of the given radius spanning z in [0, heightMm]. */
  cylinder(radiusMm: number, heightMm: number, segments?: number): Solid;
  /** An axis-aligned box. When center=true it is centred on the origin. */
  box(xMm: number, yMm: number, zMm: number, center?: boolean): Solid;
  sphere(radiusMm: number, segments?: number): Solid;
  /**
   * Offset (inflate > 0 / deflate < 0) closed contours using Clipper2.
   * Returns the resolved polygons; an empty array means the shape vanished.
   */
  offsetContours(contours: Contour[], deltaMm: number, join?: ContourJoin): Contour[];
  /** Resolve raw contours with the NonZero fill rule (dedup/self-union). */
  resolveContours(contours: Contour[]): Contour[];
  /** Union of many solids (consumes all). Throws on empty list. */
  unionAll(solids: Solid[]): Solid;
  /**
   * Build a solid from indexed triangles. Open meshes are merged/welded when
   * possible. Returns the solid plus the kernel status; a non-"NoError"
   * status means the input is not a valid manifold (solid will be empty).
   */
  fromMeshData(mesh: MeshData): { solid: Solid; status: string };
}

class ManifoldSolid implements Solid {
  /** Internal: only the kernel module touches the raw Manifold handle. */
  constructor(readonly manifold: Manifold) {}

  private wrap(next: Manifold): Solid {
    this.manifold.delete();
    return new ManifoldSolid(next);
  }

  translate(x: number, y: number, z: number): Solid {
    return this.wrap(this.manifold.translate(x, y, z));
  }

  rotate(xDeg: number, yDeg: number, zDeg: number): Solid {
    return this.wrap(this.manifold.rotate(xDeg, yDeg, zDeg));
  }

  scale(x: number, y: number, z: number): Solid {
    return this.wrap(this.manifold.scale([x, y, z]));
  }

  mirror(nx: number, ny: number, nz: number): Solid {
    return this.wrap(this.manifold.mirror([nx, ny, nz]));
  }

  transform(mat4ColumnMajor: number[]): Solid {
    if (mat4ColumnMajor.length !== 16) {
      throw new Error("transform expects a 16-element column-major matrix");
    }
    return this.wrap(
      this.manifold.transform(mat4ColumnMajor as Parameters<Manifold["transform"]>[0])
    );
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

  intersect(other: Solid): Solid {
    const b = (other as ManifoldSolid).manifold;
    const next = this.manifold.intersect(b);
    this.manifold.delete();
    b.delete();
    return new ManifoldSolid(next);
  }

  splitByPlane(nx: number, ny: number, nz: number, offsetMm: number): [Solid, Solid] {
    const [above, below] = this.manifold.splitByPlane([nx, ny, nz], offsetMm);
    this.manifold.delete();
    return [new ManifoldSolid(above), new ManifoldSolid(below)];
  }

  trimByPlane(nx: number, ny: number, nz: number, offsetMm: number): Solid {
    return this.wrap(this.manifold.trimByPlane([nx, ny, nz], offsetMm));
  }

  slicePolygons(z: number): Contour[] {
    const section = this.manifold.slice(z);
    const polygons = section.toPolygons().map((poly) =>
      poly.map((p): Vec2Tuple => [p[0], p[1]])
    );
    section.delete();
    return polygons;
  }

  decompose(): Solid[] {
    const parts = this.manifold.decompose();
    this.manifold.delete();
    return parts.map((part) => new ManifoldSolid(part));
  }

  simplify(toleranceMm: number): Solid {
    return this.wrap(this.manifold.simplify(toleranceMm));
  }

  hull(): Solid {
    return this.wrap(this.manifold.hull());
  }

  minkowskiSum(other: Solid): Solid {
    const b = (other as ManifoldSolid).manifold;
    const next = this.manifold.minkowskiSum(b);
    this.manifold.delete();
    b.delete();
    return new ManifoldSolid(next);
  }

  minkowskiDifference(other: Solid): Solid {
    const b = (other as ManifoldSolid).manifold;
    const next = this.manifold.minkowskiDifference(b);
    this.manifold.delete();
    b.delete();
    return new ManifoldSolid(next);
  }

  duplicate(): Solid {
    // A zero translation creates a new cheap handle to the same geometry.
    return new ManifoldSolid(this.manifold.translate(0, 0, 0));
  }

  isEmpty(): boolean {
    return this.manifold.isEmpty();
  }

  status(): string {
    return this.manifold.status();
  }

  numTriangles(): number {
    return this.manifold.numTri();
  }

  genus(): number {
    return this.manifold.genus();
  }

  volumeMm3(): number {
    return this.manifold.volume();
  }

  surfaceAreaMm2(): number {
    return this.manifold.surfaceArea();
  }

  boundingBox(): SolidBounds {
    const box = this.manifold.boundingBox();
    return {
      min: { x: box.min[0], y: box.min[1], z: box.min[2] },
      max: { x: box.max[0], y: box.max[1], z: box.max[2] },
    };
  }

  rayCast(
    origin: { x: number; y: number; z: number },
    end: { x: number; y: number; z: number }
  ): SolidRayHit[] {
    const hits = this.manifold.rayCast(
      [origin.x, origin.y, origin.z],
      [end.x, end.y, end.z]
    );
    // Manifold reports distance as a 0..1 fraction of the segment; convert
    // to millimetres so callers can reason in real units.
    const segmentLength = Math.hypot(end.x - origin.x, end.y - origin.y, end.z - origin.z);
    return hits.map((hit) => ({
      distance: hit.distance * segmentLength,
      position: { x: hit.position[0], y: hit.position[1], z: hit.position[2] },
      normal: { x: hit.normal[0], y: hit.normal[1], z: hit.normal[2] },
    }));
  }

  toGeometry(): THREE.BufferGeometry {
    const data = this.toMeshData();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geometry.computeVertexNormals();
    return geometry;
  }

  toMeshData(): MeshData {
    const mesh = this.manifold.getMesh();
    let positions: Float32Array;
    if (mesh.numProp === 3) {
      positions = new Float32Array(mesh.vertProperties);
    } else {
      const count = mesh.vertProperties.length / mesh.numProp;
      positions = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        positions[i * 3] = mesh.vertProperties[i * mesh.numProp];
        positions[i * 3 + 1] = mesh.vertProperties[i * mesh.numProp + 1];
        positions[i * 3 + 2] = mesh.vertProperties[i * mesh.numProp + 2];
      }
    }
    return { positions, indices: new Uint32Array(mesh.triVerts) };
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

  box(xMm: number, yMm: number, zMm: number, center = false): Solid {
    const { Manifold } = this.wasm;
    return new ManifoldSolid(Manifold.cube([xMm, yMm, zMm], center));
  }

  sphere(radiusMm: number, segments = 48): Solid {
    const { Manifold } = this.wasm;
    return new ManifoldSolid(Manifold.sphere(radiusMm, segments));
  }

  offsetContours(contours: Contour[], deltaMm: number, join: ContourJoin = "round"): Contour[] {
    const { CrossSection } = this.wasm;
    const joinType = join === "round" ? "Round" : join === "miter" ? "Miter" : "Square";
    const section = new CrossSection(contours, "NonZero");
    const offset = section.offset(deltaMm, joinType);
    const polygons = offset.toPolygons().map((poly) =>
      poly.map((p): Vec2Tuple => [p[0], p[1]])
    );
    section.delete();
    offset.delete();
    return polygons;
  }

  resolveContours(contours: Contour[]): Contour[] {
    const { CrossSection } = this.wasm;
    const section = new CrossSection(contours, "NonZero");
    const polygons = section.toPolygons().map((poly) =>
      poly.map((p): Vec2Tuple => [p[0], p[1]])
    );
    section.delete();
    return polygons;
  }

  unionAll(solids: Solid[]): Solid {
    if (solids.length === 0) throw new Error("unionAll requires at least one solid");
    const { Manifold } = this.wasm;
    const manifolds = solids.map((s) => (s as ManifoldSolid).manifold);
    const result = Manifold.union(manifolds);
    for (const m of manifolds) m.delete();
    return new ManifoldSolid(result);
  }

  fromMeshData(data: MeshData): { solid: Solid; status: string } {
    const { Mesh, Manifold } = this.wasm;
    const mesh = new Mesh({
      numProp: 3,
      vertProperties: data.positions,
      triVerts: data.indices,
    });
    // Weld open edges within tolerance so near-manifold STL files load.
    try {
      mesh.merge();
    } catch {
      // merge() throws when the mesh cannot be repaired; fall through so
      // ofMesh reports the precise status.
    }
    let manifold: Manifold;
    try {
      manifold = Manifold.ofMesh(mesh);
    } catch (err) {
      return {
        solid: new ManifoldSolid(this.wasm.Manifold.cube([0, 0, 0])),
        status: err instanceof Error ? err.message : "NotManifold",
      };
    }
    const solid = new ManifoldSolid(manifold);
    return { solid, status: solid.status() };
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
