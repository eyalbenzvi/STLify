"use client";

/**
 * 3D preview for the eDrawings import screen.
 *
 * Shows the selected components exactly as they will be placed — the same
 * unit, up-axis and scale numbers as the import (placement.ts), applied as a
 * group transform so changing an option does not rebuild any geometry.
 */

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { meshDataToGeometry } from "@/lib/geometry/meshData";
import type { EDrawingsComponent } from "@/lib/import/edrawings/model";
import {
  concatMeshes,
  placedBounds,
  placementFactor,
  rebaseOffset,
  type EDrawingsPlacement,
} from "@/lib/import/edrawings/placement";

const DEFAULT_COLOR = "#9ca3af";

function ComponentMesh({ component }: { component: EDrawingsComponent }) {
  const geometry = useMemo(
    () => meshDataToGeometry(concatMeshes(component.bodies)),
    [component.bodies]
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial
        color={component.colorHex ?? DEFAULT_COLOR}
        side={THREE.DoubleSide}
        metalness={0.05}
        roughness={0.8}
      />
    </mesh>
  );
}

/** Re-aim the camera whenever the framed box changes. */
function FitCamera({ center, radius }: { center: THREE.Vector3; radius: number }) {
  // Read through get() inside the effect: the camera is three.js state the
  // effect mutates on purpose, not a React value.
  const get = useThree((s) => s.get);
  // Subscribed only so the effect re-runs once OrbitControls registers.
  const controlsReady = useThree((s) => s.controls !== null);
  useEffect(() => {
    const { camera, controls, invalidate } = get();
    const orbit = controls as unknown as { target: THREE.Vector3; update: () => void } | null;
    const distance = Math.max(radius, 1) * 2.4;
    camera.position.set(center.x + distance * 0.7, center.y - distance, center.z + distance * 0.6);
    camera.near = Math.max(distance / 1000, 0.01);
    camera.far = distance * 20;
    camera.updateProjectionMatrix();
    if (orbit) {
      orbit.target.copy(center);
      orbit.update();
    } else {
      camera.lookAt(center);
    }
    invalidate();
  }, [get, center, radius, controlsReady]);
  return null;
}

export function EDrawingsPreview({
  components,
  placement,
}: {
  components: EDrawingsComponent[];
  placement: EDrawingsPlacement;
}) {
  const factor = placementFactor(placement);
  const bounds = useMemo(
    () => placedBounds(components.map((c) => c.bounds), placement),
    [components, placement]
  );
  const offset = bounds ? rebaseOffset(bounds) : ([0, 0, 0] as [number, number, number]);
  const size = bounds ? bounds.max.map((v, i) => v - bounds.min[i]) : [0, 0, 0];
  const center = useMemo(() => new THREE.Vector3(0, 0, size[2] / 2), [size[2]]); // eslint-disable-line react-hooks/exhaustive-deps
  const radius = Math.hypot(size[0], size[1], size[2]) / 2;

  return (
    <Canvas
      className="h-full w-full"
      camera={{ up: [0, 0, 1], fov: 40, position: [200, -300, 200] }}
      frameloop="demand"
      gl={{ antialias: true }}
    >
      <color attach="background" args={["#f1f5f9"]} />
      <hemisphereLight args={["#ffffff", "#94a3b8", 1.6]} />
      <directionalLight position={[1, -1.5, 2]} intensity={1.4} />
      <group position={offset}>
        <group
          scale={[factor, factor, factor]}
          rotation={placement.upAxis === "y" ? [Math.PI / 2, 0, 0] : [0, 0, 0]}
        >
          {components.map((component) => (
            <ComponentMesh key={component.id} component={component} />
          ))}
        </group>
      </group>
      <gridHelper
        args={[Math.max(radius * 3, 10), 20, "#94a3b8", "#cbd5e1"]}
        rotation={[Math.PI / 2, 0, 0]}
      />
      <OrbitControls makeDefault enableDamping={false} />
      <FitCamera center={center} radius={radius} />
    </Canvas>
  );
}
