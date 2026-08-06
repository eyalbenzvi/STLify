"use client";

/**
 * V2 3D viewer: renders the built parts with their preview colours,
 * click-to-select layers, camera presets (front/top/side/iso + fit),
 * grid/axes/build-plate toggles, material-appearance preview, and an
 * exploded view for multi-colour designs.
 *
 * The scene is Z-up (STL/slicer convention).
 */

import { Canvas, useThree } from "@react-three/fiber";
import { Grid, OrbitControls } from "@react-three/drei";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { BuiltPart } from "@/lib/geometry/buildDesign";

export type MaterialAppearance = "matte" | "glossy" | "metallic";

interface DesignViewerProps {
  parts: BuiltPart[];
  selectedLayerId: string | null;
  building: boolean;
  buildPlateMm: { x: number; y: number };
  onSelectLayer: (layerId: string | null) => void;
}

type CameraPreset = "iso" | "front" | "top" | "side";

const APPEARANCES: Record<MaterialAppearance, { metalness: number; roughness: number }> = {
  matte: { metalness: 0.05, roughness: 0.75 },
  glossy: { metalness: 0.1, roughness: 0.25 },
  metallic: { metalness: 0.85, roughness: 0.35 },
};

function CameraRig({
  preset,
  fitSignal,
  parts,
  controlsRef,
}: {
  preset: { name: CameraPreset; tick: number };
  fitSignal: number;
  parts: BuiltPart[];
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
}) {
  const camera = useThree((s) => s.camera);
  const partsRef = useRef(parts);

  // Keep the latest parts available to the preset effect without making
  // every rebuild move the camera.
  useEffect(() => {
    partsRef.current = parts;
  }, [parts]);

  useEffect(() => {
    // Fit distance from the model bounds.
    const box = new THREE.Box3();
    for (const part of partsRef.current) {
      part.geometry.computeBoundingBox();
      if (part.geometry.boundingBox) box.union(part.geometry.boundingBox);
    }
    const size = new THREE.Vector3(100, 100, 20);
    const center = new THREE.Vector3(0, 0, 5);
    if (!box.isEmpty()) {
      box.getSize(size);
      box.getCenter(center);
    }
    const radius = Math.max(size.length() / 2, 20);
    const dist = radius * 2.4;
    const positions: Record<CameraPreset, [number, number, number]> = {
      iso: [center.x + dist * 0.55, center.y - dist * 0.75, center.z + dist * 0.6],
      front: [center.x, center.y - dist, center.z + size.z / 2],
      top: [center.x, center.y - 0.001, center.z + dist],
      side: [center.x + dist, center.y, center.z + size.z / 2],
    };
    camera.position.set(...positions[preset.name]);
    camera.up.set(0, 0, 1);
    camera.lookAt(center);
    controlsRef.current?.target.copy(center);
    controlsRef.current?.update();
  }, [preset, fitSignal, camera, controlsRef]);
  return null;
}

export function DesignViewer({
  parts,
  selectedLayerId,
  building,
  buildPlateMm,
  onSelectLayer,
}: DesignViewerProps) {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const [preset, setPreset] = useState<{ name: CameraPreset; tick: number }>({ name: "iso", tick: 0 });
  const [fitSignal, setFitSignal] = useState(0);
  const [showGrid, setShowGrid] = useState(true);
  const [showAxes, setShowAxes] = useState(true);
  const [showPlate, setShowPlate] = useState(true);
  const [appearance, setAppearance] = useState<MaterialAppearance>("matte");
  const [exploded, setExploded] = useState(0);

  const setView = useCallback((name: CameraPreset) => {
    setPreset((p) => ({ name, tick: p.tick + 1 }));
  }, []);

  const mat = APPEARANCES[appearance];
  const nonBaseIndex = useMemo(() => {
    const map = new Map<string, number>();
    let i = 0;
    for (const part of parts) {
      if (part.kind !== "base") map.set(part.key, ++i);
    }
    return map;
  }, [parts]);

  const multiPart = parts.length > 1;

  return (
    <div className="relative h-full w-full" dir="ltr">
      <Canvas
        camera={{ position: [90, -140, 110], up: [0, 0, 1], fov: 40, near: 0.1, far: 3000 }}
        className="h-full w-full"
        onPointerMissed={() => onSelectLayer(null)}
      >
        <color attach="background" args={["#eef2f7"]} />
        <ambientLight intensity={0.55} />
        <directionalLight position={[60, -80, 120]} intensity={1.1} />
        <directionalLight position={[-60, 80, 40]} intensity={0.35} />

        <CameraRig preset={preset} fitSignal={fitSignal} parts={parts} controlsRef={controlsRef} />

        {parts.map((part) => {
          const selected = part.layerId === selectedLayerId;
          const explodeZ = exploded * 12 * (nonBaseIndex.get(part.key) ?? 0);
          return (
            <mesh
              key={part.key}
              geometry={part.geometry}
              position={[0, 0, explodeZ]}
              onClick={(e) => {
                e.stopPropagation();
                onSelectLayer(part.layerId);
              }}
            >
              <meshStandardMaterial
                color={part.colorHex}
                metalness={mat.metalness}
                roughness={mat.roughness}
                flatShading
                transparent={building}
                opacity={building ? 0.55 : 1}
                emissive={selected ? "#2f6feb" : "#000000"}
                emissiveIntensity={selected ? 0.35 : 0}
              />
            </mesh>
          );
        })}

        {/* Build-plate preview. */}
        {showPlate && (
          <mesh position={[0, 0, -0.15]}>
            <boxGeometry args={[buildPlateMm.x, buildPlateMm.y, 0.2]} />
            <meshStandardMaterial color="#d7dde7" transparent opacity={0.5} />
          </mesh>
        )}

        {showGrid && (
          <Grid
            args={[500, 500]}
            rotation={[Math.PI / 2, 0, 0]}
            cellSize={10}
            cellColor="#c3ccd9"
            sectionSize={50}
            sectionColor="#93a1b5"
            fadeDistance={600}
            position={[0, 0, -0.31]}
            side={2}
          />
        )}
        {showAxes && <axesHelper args={[30]} />}

        <OrbitControls ref={controlsRef} makeDefault enableDamping enablePan />
      </Canvas>

      {/* Viewer toolbar. */}
      <div className="absolute end-3 top-3 flex flex-col items-end gap-1.5" dir="rtl">
        <div className="flex gap-1 rounded-lg bg-white/90 p-1 shadow-sm">
          <ViewButton onClick={() => setView("iso")} label="מבט איזומטרי">⬦</ViewButton>
          <ViewButton onClick={() => setView("front")} label="מבט קדמי">◻</ViewButton>
          <ViewButton onClick={() => setView("top")} label="מבט עליון">⬒</ViewButton>
          <ViewButton onClick={() => setView("side")} label="מבט צד">▯</ViewButton>
          <ViewButton
            onClick={() => setFitSignal((s) => s + 1)}
            label="התאמת המודל לתצוגה"
          >
            ⛶
          </ViewButton>
        </div>
        <div className="flex gap-1 rounded-lg bg-white/90 p-1 shadow-sm">
          <ViewButton onClick={() => setShowGrid((v) => !v)} label="רשת" active={showGrid}>▦</ViewButton>
          <ViewButton onClick={() => setShowAxes((v) => !v)} label="צירים" active={showAxes}>⌖</ViewButton>
          <ViewButton onClick={() => setShowPlate((v) => !v)} label="משטח הדפסה" active={showPlate}>▬</ViewButton>
        </div>
        <div className="flex items-center gap-1 rounded-lg bg-white/90 px-2 py-1 text-xs text-slate-600 shadow-sm">
          <span>מראה (תצוגה בלבד):</span>
          <select
            aria-label="מראה חומר בתצוגה"
            className="rounded border border-slate-200 bg-white px-1 py-0.5"
            value={appearance}
            onChange={(e) => setAppearance(e.target.value as MaterialAppearance)}
          >
            <option value="matte">מט</option>
            <option value="glossy">מבריק</option>
            <option value="metallic">מתכתי</option>
          </select>
        </div>
        {multiPart && (
          <label className="flex items-center gap-2 rounded-lg bg-white/90 px-2 py-1 text-xs text-slate-600 shadow-sm">
            תצוגה מפורקת
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={exploded}
              aria-label="תצוגה מפורקת"
              onChange={(e) => setExploded(Number(e.target.value))}
            />
          </label>
        )}
      </div>

      {building && (
        <div className="pointer-events-none absolute start-3 top-3 flex items-center gap-2 rounded-md bg-white/90 px-3 py-1.5 text-xs text-slate-600 shadow-sm" dir="rtl">
          <span className="inline-block size-3 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600" />
          בונה מודל…
        </div>
      )}
    </div>
  );
}

function ViewButton({
  children,
  onClick,
  label,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={`grid size-7 place-items-center rounded-md text-sm ${
        active === false
          ? "text-slate-300 hover:bg-slate-100"
          : "text-slate-600 hover:bg-slate-100"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
