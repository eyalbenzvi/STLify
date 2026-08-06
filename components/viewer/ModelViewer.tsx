"use client";

import { Canvas } from "@react-three/fiber";
import { Grid, OrbitControls } from "@react-three/drei";
import { useRef } from "react";
import type * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";

interface ModelViewerProps {
  geometry: THREE.BufferGeometry | null;
  color: string;
  /** True while a rebuild is in flight (dims the stale model). */
  building: boolean;
}

/**
 * 3D preview panel. The model is Z-up (the STL/slicer convention), so the
 * camera's up axis is set to +Z and the grid is rotated into the XY plane —
 * the preview then matches exactly what a slicer will show.
 */
export function ModelViewer({ geometry, color, building }: ModelViewerProps) {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);

  return (
    <div className="relative h-full w-full" dir="ltr">
      <Canvas
        camera={{
          position: [0, -160, 110],
          up: [0, 0, 1],
          fov: 40,
          near: 0.1,
          far: 2000,
        }}
        className="h-full w-full"
      >
        <color attach="background" args={["#eef2f7"]} />
        <ambientLight intensity={0.55} />
        <directionalLight position={[60, -80, 120]} intensity={1.1} />
        <directionalLight position={[-60, 80, 40]} intensity={0.35} />

        {geometry && (
          <mesh geometry={geometry}>
            <meshStandardMaterial
              color={color}
              metalness={0.05}
              roughness={0.55}
              flatShading
              transparent={building}
              opacity={building ? 0.55 : 1}
            />
          </mesh>
        )}

        {/* drei's Grid lies in XZ by default; rotate it into the XY plane. */}
        <Grid
          args={[400, 400]}
          rotation={[Math.PI / 2, 0, 0]}
          cellSize={10}
          cellColor="#c3ccd9"
          sectionSize={50}
          sectionColor="#93a1b5"
          fadeDistance={500}
          position={[0, 0, -0.01]}
          side={2}
        />
        <axesHelper args={[30]} />

        <OrbitControls ref={controlsRef} makeDefault enableDamping />
      </Canvas>

      <button
        type="button"
        className="absolute end-3 top-3 rounded-md border border-slate-300 bg-white/90 px-3 py-1.5 text-xs text-slate-700 shadow-sm transition-colors hover:bg-white"
        onClick={() => controlsRef.current?.reset()}
      >
        איפוס מצלמה
      </button>
    </div>
  );
}
