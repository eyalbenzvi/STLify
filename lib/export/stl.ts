/**
 * Binary STL export. STL is unit-less by convention; this app models in
 * millimetres, so 1 STL unit = 1 mm (the convention every slicer assumes).
 */

import * as THREE from "three";

/** Serialize a geometry to a binary STL blob. */
export function geometryToBinaryStl(geometry: THREE.BufferGeometry): Blob {
  const source = geometry.index ? geometry.toNonIndexed() : geometry;
  const position = source.getAttribute("position");
  const triangleCount = position.count / 3;

  const buffer = new ArrayBuffer(84 + triangleCount * 50);
  const view = new DataView(buffer);

  // 80-byte header (ASCII, informational only).
  const header = "PrintCraft STL Studio - units: mm";
  for (let i = 0; i < Math.min(header.length, 80); i++) {
    view.setUint8(i, header.charCodeAt(i));
  }
  view.setUint32(80, triangleCount, true);

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const normal = new THREE.Vector3();

  let offset = 84;
  for (let i = 0; i < triangleCount; i++) {
    a.fromBufferAttribute(position, i * 3);
    b.fromBufferAttribute(position, i * 3 + 1);
    c.fromBufferAttribute(position, i * 3 + 2);

    ab.subVectors(b, a);
    ac.subVectors(c, a);
    normal.crossVectors(ab, ac).normalize();

    for (const v of [normal, a, b, c]) {
      view.setFloat32(offset, v.x, true);
      view.setFloat32(offset + 4, v.y, true);
      view.setFloat32(offset + 8, v.z, true);
      offset += 12;
    }
    view.setUint16(offset, 0, true); // attribute byte count
    offset += 2;
  }

  if (source !== geometry) source.dispose();
  return new Blob([buffer], { type: "model/stl" });
}

/** Trigger a browser download of the given blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
