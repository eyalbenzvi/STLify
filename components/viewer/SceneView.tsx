"use client";

/**
 * The V3 3D viewport: multi-part scene with selection, transform gizmos
 * (translate/rotate/scale with snapping and local/world spaces), build
 * plate + printer volume, preview-only clipping section, measurement
 * picking, surface picking (place-on-surface / drain holes), analysis
 * vertex-color overlays and an approximate layer-line print preview.
 *
 * The model space is Z-up (slicer convention): the camera's up axis is +Z
 * so the on-screen model matches the exported STL exactly.
 *
 * React context does not cross the R3F renderer boundary, so everything
 * arrives via props from the editor shell.
 */

import { Canvas, useThree, type ThreeEvent } from "@react-three/fiber";
import { GizmoHelper, GizmoViewport, Grid, Html, Line, OrbitControls, TransformControls } from "@react-three/drei";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as THREE from "three";
import type { DesignDocument, Measurement, Transform3D } from "@/types/design";
import type { PrinterProfile } from "@/types/profiles";
import type { BuiltPart } from "@/hooks/useDocumentBuilder";
import { matrix4ToTransform, snapTransformNoise } from "@/lib/geometry/transform";
import type {
  EditorTool,
  OverlayMode,
  PrintPreviewState,
  SectionPlaneState,
  SnapSettings,
} from "@/components/editor/store";

export interface SurfacePick {
  point: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
  primaryLayerId: string;
}

export interface SceneViewProps {
  document: DesignDocument;
  parts: BuiltPart[];
  selection: string[];
  tool: EditorTool;
  transformSpace: "world" | "local";
  snap: SnapSettings;
  xray: boolean;
  section: SectionPlaneState;
  printPreview: PrintPreviewState;
  overlay: OverlayMode;
  /** primaryLayerId → per-vertex RGB colors for the active overlay. */
  overlayColors: ReadonlyMap<string, Float32Array>;
  measurements: Measurement[];
  printer: PrinterProfile;
  building: boolean;
  onSelect: (layerIds: string[], additive: boolean) => void;
  onCommitTransform: (layerId: string, transform: Transform3D) => void;
  onSurfacePick: (pick: SurfacePick) => void;
  onAddMeasurement: (a: THREE.Vector3, b: THREE.Vector3) => void;
  /**
   * World point to centre the camera on. Set by the mesh inspector and the
   * interference report so a listed problem can be looked at rather than
   * merely described. A new object identity re-triggers the move, so the
   * same location can be revisited.
   */
  focusTarget?: { x: number; y: number; z: number } | null;
}

/** Material color for a part, honouring its material slot. */
function partColor(document: DesignDocument, part: BuiltPart): string {
  const slot = document.materialSlots.find((s) => s.id === part.materialSlotId);
  return slot?.colorHex ?? "#2f6feb";
}

/** Inject approximate layer-line stripes into a standard material. */
function applyLayerLines(
  material: THREE.MeshStandardMaterial,
  layerHeightMm: number
): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uLayerHeight = { value: Math.max(layerHeightMm, 0.05) };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying float vWorldZ;"
      )
      .replace(
        "#include <worldpos_vertex>",
        "#include <worldpos_vertex>\nvWorldZ = (modelMatrix * vec4(transformed, 1.0)).z;"
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying float vWorldZ;\nuniform float uLayerHeight;"
      )
      .replace(
        "#include <dithering_fragment>",
        `#include <dithering_fragment>
  float layerPhase = fract(vWorldZ / uLayerHeight);
  float lineWidth = 0.18;
  float stripe = smoothstep(0.0, lineWidth, layerPhase) * smoothstep(1.0, 1.0 - lineWidth, layerPhase);
  gl_FragColor.rgb *= mix(0.82, 1.0, stripe);`
      );
  };
  material.needsUpdate = true;
}

interface PartMeshProps {
  document: DesignDocument;
  part: BuiltPart;
  selected: boolean;
  xray: boolean;
  building: boolean;
  overlay: OverlayMode;
  overlayColors: Float32Array | null;
  clippingPlanes: THREE.Plane[];
  printPreview: PrintPreviewState;
  pickMode: boolean;
  registerObject: (layerId: string, object: THREE.Group | null) => void;
  onClick: (event: ThreeEvent<MouseEvent>, part: BuiltPart) => void;
}

const PartMesh = memo(function PartMesh({
  document,
  part,
  selected,
  xray,
  building,
  overlay,
  overlayColors,
  clippingPlanes,
  printPreview,
  pickMode,
  registerObject,
  onClick,
}: PartMeshProps) {
  const groupRef = useRef<THREE.Group>(null);
  const primaryLayer = document.layers.find((l) => l.id === part.primaryLayerId);
  const layerOpacity = primaryLayer?.previewOpacity ?? 1;
  const opacity = xray ? Math.min(0.35, layerOpacity) : layerOpacity;
  const transparent = opacity < 0.999 || building;

  // Register the group for gizmo attachment.
  useEffect(() => {
    registerObject(part.primaryLayerId, groupRef.current);
    return () => registerObject(part.primaryLayerId, null);
  }, [part.primaryLayerId, registerObject]);

  // Pose the group from the part's world matrix (decomposed so
  // TransformControls can manipulate position/quaternion/scale directly).
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    part.worldMatrix.decompose(position, quaternion, scale);
    group.position.copy(position);
    group.quaternion.copy(quaternion);
    group.scale.copy(scale);
    group.updateMatrix();
  }, [part.worldMatrix, part]);

  // Vertex colors for analysis overlays.
  useEffect(() => {
    const geometry = part.geometry;
    if (overlay !== "none" && overlayColors) {
      geometry.setAttribute("color", new THREE.BufferAttribute(overlayColors, 3));
    } else if (geometry.getAttribute("color")) {
      geometry.deleteAttribute("color");
    }
    // Imperative three.js buffer invalidation — external-system sync.
    // eslint-disable-next-line react-hooks/immutability
    geometry.attributes.position.needsUpdate = true;
  }, [part.geometry, overlay, overlayColors]);

  const useVertexColors = overlay !== "none" && overlayColors !== null;
  const color = useVertexColors ? "#ffffff" : partColor(document, part);

  const materialRef = useRef<THREE.MeshStandardMaterial>(null);
  useEffect(() => {
    const material = materialRef.current;
    if (!material) return;
    if (printPreview.enabled) {
      applyLayerLines(material, printPreview.layerHeightMm);
    } else {
      material.onBeforeCompile = () => undefined;
      material.needsUpdate = true;
    }
  }, [printPreview.enabled, printPreview.layerHeightMm]);

  const bbox = useMemo(() => {
    part.geometry.computeBoundingBox();
    return part.geometry.boundingBox ?? new THREE.Box3();
  }, [part.geometry]);

  return (
    <group ref={groupRef}>
      <mesh
        geometry={part.geometry}
        onClick={(event) => onClick(event, part)}
        onPointerOver={(e) => {
          if (pickMode) {
            e.stopPropagation();
            window.document.body.style.cursor = "crosshair";
          }
        }}
        onPointerOut={() => {
          window.document.body.style.cursor = "auto";
        }}
      >
        <meshStandardMaterial
          ref={materialRef}
          key={`${printPreview.enabled}-${printPreview.layerHeightMm}-${useVertexColors}`}
          color={color}
          metalness={0.05}
          roughness={0.55}
          flatShading={!useVertexColors}
          vertexColors={useVertexColors}
          transparent={transparent}
          opacity={building ? Math.min(opacity, 0.55) : opacity}
          clippingPlanes={clippingPlanes}
          side={THREE.DoubleSide}
          emissive={selected ? "#2563eb" : "#000000"}
          emissiveIntensity={selected ? 0.25 : 0}
        />
      </mesh>
      {selected && (
        <box3Helper args={[bbox, new THREE.Color("#2563eb")]} />
      )}
    </group>
  );
});

/** Printer build-volume wireframe. */
function BuildVolume({ printer }: { printer: PrinterProfile }) {
  const { x, y, z } = printer.buildVolumeMm;
  const box = useMemo(
    () =>
      new THREE.Box3(
        new THREE.Vector3(-x / 2, -y / 2, 0),
        new THREE.Vector3(x / 2, y / 2, z)
      ),
    [x, y, z]
  );
  return <box3Helper args={[box, new THREE.Color("#b6c2d4")]} />;
}

/** One measurement: line + endpoints + mm label. */
function MeasurementView({
  measurement,
  onRemove,
}: {
  measurement: Measurement;
  onRemove: (id: string) => void;
}) {
  const a = new THREE.Vector3(measurement.a.x, measurement.a.y, measurement.a.z);
  const b = new THREE.Vector3(measurement.b.x, measurement.b.y, measurement.b.z);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  return (
    <group>
      <Line points={[a, b]} color="#d97706" lineWidth={2} depthTest={false} />
      {[a, b].map((p, i) => (
        <mesh key={i} position={p}>
          <sphereGeometry args={[0.8, 12, 12]} />
          <meshBasicMaterial color="#d97706" depthTest={false} transparent opacity={0.9} />
        </mesh>
      ))}
      <Html position={mid} center zIndexRange={[20, 0]}>
        <button
          type="button"
          dir="ltr"
          title="הסרת מדידה (לחיצה)"
          onClick={() => onRemove(measurement.id)}
          className="whitespace-nowrap rounded bg-amber-600 px-1.5 py-0.5 font-mono text-[11px] text-white shadow"
        >
          {measurement.valueMm.toFixed(2)} mm
        </button>
      </Html>
    </group>
  );
}

/** Pending first point of an in-progress measurement. */
function PendingPoint({ point }: { point: THREE.Vector3 }) {
  return (
    <mesh position={point}>
      <sphereGeometry args={[1, 12, 12]} />
      <meshBasicMaterial color="#f59e0b" depthTest={false} transparent opacity={0.9} />
    </mesh>
  );
}

function SceneContent(props: SceneViewProps & { onRemoveMeasurement: (id: string) => void }) {
  const {
    document,
    parts,
    selection,
    tool,
    transformSpace,
    snap,
    xray,
    section,
    printPreview,
    overlay,
    overlayColors,
    measurements,
    printer,
    building,
    onSelect,
    onCommitTransform,
    onSurfacePick,
    onAddMeasurement,
    onRemoveMeasurement,
    focusTarget,
  } = props;

  const { gl } = useThree();
  useEffect(() => {
    // Imperative renderer flag — synchronizing an external system.
    // eslint-disable-next-line react-hooks/immutability
    gl.localClippingEnabled = true;
  }, [gl]);

  // Gizmo attachment targets live in state (not a ref) so the
  // TransformControls re-attaches as soon as a part group mounts.
  const [objects, setObjects] = useState<ReadonlyMap<string, THREE.Group>>(new Map());
  const registerObject = useCallback((layerId: string, object: THREE.Group | null) => {
    setObjects((prev) => {
      const next = new Map(prev);
      if (object) next.set(layerId, object);
      else next.delete(layerId);
      return next;
    });
  }, []);

  const [pendingPoint, setPendingPoint] = useState<THREE.Vector3 | null>(null);
  // Reset the half-finished measurement when leaving measure mode
  // (state adjustment derived from a prop change, done during render).
  const [prevTool, setPrevTool] = useState(tool);
  if (tool !== prevTool) {
    setPrevTool(tool);
    if (tool !== "measure") setPendingPoint(null);
  }

  const clippingPlanes = useMemo(() => {
    if (!section.enabled) return [];
    const normal = new THREE.Vector3(
      section.axis === "x" ? -1 : 0,
      section.axis === "y" ? -1 : 0,
      section.axis === "z" ? -1 : 0
    );
    if (section.flip) normal.negate();
    return [new THREE.Plane(normal, section.offsetMm * (section.flip ? -1 : 1))];
  }, [section]);

  const pickMode = tool === "measure" || tool === "placeOnSurface" || tool === "drainHole";

  const handlePartClick = useCallback(
    (event: ThreeEvent<MouseEvent>, part: BuiltPart) => {
      event.stopPropagation();
      if (tool === "measure") {
        const point = event.point.clone();
        if (!pendingPoint) {
          setPendingPoint(point);
        } else {
          onAddMeasurement(pendingPoint, point);
          setPendingPoint(null);
        }
        return;
      }
      if (tool === "placeOnSurface" || tool === "drainHole") {
        const face = event.face;
        if (!face || !event.object) return;
        const worldNormal = face.normal
          .clone()
          .transformDirection(event.object.matrixWorld)
          .normalize();
        onSurfacePick({
          point: { x: event.point.x, y: event.point.y, z: event.point.z },
          normal: { x: worldNormal.x, y: worldNormal.y, z: worldNormal.z },
          primaryLayerId: part.primaryLayerId,
        });
        return;
      }
      onSelect([part.primaryLayerId], event.ctrlKey || event.metaKey || event.shiftKey);
    },
    [tool, pendingPoint, onAddMeasurement, onSurfacePick, onSelect]
  );

  // Gizmo target: the single selected layer that owns a part.
  const gizmoLayerId =
    selection.length === 1 && parts.some((p) => p.primaryLayerId === selection[0])
      ? selection[0]
      : null;
  const gizmoLayer = gizmoLayerId
    ? document.layers.find((l) => l.id === gizmoLayerId)
    : null;
  const gizmoObject = gizmoLayerId ? (objects.get(gizmoLayerId) ?? null) : null;
  const gizmoMode =
    tool === "translate" || tool === "rotate" || tool === "scale" ? tool : null;
  const showGizmo = Boolean(
    gizmoMode && gizmoObject && gizmoLayer && !gizmoLayer.locked
  );

  const commitGizmo = useCallback(() => {
    if (!gizmoLayerId) return;
    const object = objects.get(gizmoLayerId);
    if (!object) return;
    object.updateMatrix();
    const transform = snapTransformNoise(matrix4ToTransform(object.matrix));
    onCommitTransform(gizmoLayerId, transform);
  }, [gizmoLayerId, objects, onCommitTransform]);

  return (
    <>
      <color attach="background" args={["#eef2f7"]} />
      <ambientLight intensity={0.55} />
      <directionalLight position={[60, -80, 120]} intensity={1.1} />
      <directionalLight position={[-60, 80, 40]} intensity={0.35} />

      {parts.map((part) => (
        <PartMesh
          key={part.id}
          document={document}
          part={part}
          selected={selection.includes(part.primaryLayerId)}
          xray={xray}
          building={building}
          overlay={overlay}
          overlayColors={overlayColors.get(part.primaryLayerId) ?? null}
          clippingPlanes={clippingPlanes}
          printPreview={printPreview}
          pickMode={pickMode}
          registerObject={registerObject}
          onClick={handlePartClick}
        />
      ))}

      {showGizmo && gizmoObject && gizmoMode && (
        <TransformControls
          object={gizmoObject}
          mode={gizmoMode}
          space={transformSpace}
          translationSnap={snap.enabled ? snap.positionMm : null}
          rotationSnap={snap.enabled ? (snap.rotationDeg * Math.PI) / 180 : null}
          scaleSnap={snap.enabled ? snap.scaleStep : null}
          onMouseUp={commitGizmo}
          size={0.8}
        />
      )}

      {measurements.map((m) => (
        <MeasurementView key={m.id} measurement={m} onRemove={onRemoveMeasurement} />
      ))}
      {pendingPoint && <PendingPoint point={pendingPoint} />}

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
      <BuildVolume printer={printer} />

      <GizmoHelper alignment="top-left" margin={[70, 70]}>
        <GizmoViewport labelColor="white" axisHeadScale={0.9} />
      </GizmoHelper>

      <OrbitControls makeDefault enableDamping />
      <CameraFocus target={focusTarget ?? null} />
    </>
  );
}

/**
 * Pans the orbit target onto a world point, keeping the current viewing
 * direction and distance so the user does not lose their bearings.
 */
function CameraFocus({ target }: { target: { x: number; y: number; z: number } | null }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as
    | { target: THREE.Vector3; update: () => void }
    | null;

  useEffect(() => {
    if (!target || !controls) return;
    const next = new THREE.Vector3(target.x, target.y, target.z);
    const offset = camera.position.clone().sub(controls.target);
    controls.target.copy(next);
    camera.position.copy(next).add(offset);
    controls.update();
  }, [target, controls, camera]);

  return null;
}

export function SceneView(
  props: SceneViewProps & { onRemoveMeasurement: (id: string) => void }
) {
  return (
    <div className="relative h-full w-full" dir="ltr">
      <Canvas
        camera={{ position: [0, -160, 110], up: [0, 0, 1], fov: 40, near: 0.1, far: 3000 }}
        className="h-full w-full"
        gl={{ localClippingEnabled: true }}
      >
        <SceneContent {...props} />
      </Canvas>
      {props.tool === "measure" && (
        <div className="pointer-events-none absolute start-1/2 top-3 -translate-x-1/2 rounded-md bg-amber-600/90 px-3 py-1 text-xs text-white shadow">
          מצב מדידה: לחצו על שתי נקודות על המודל
        </div>
      )}
      {props.tool === "placeOnSurface" && (
        <div className="pointer-events-none absolute start-1/2 top-3 -translate-x-1/2 rounded-md bg-blue-600/90 px-3 py-1 text-xs text-white shadow">
          לחצו על משטח יעד כדי להניח עליו את האובייקט הנבחר
        </div>
      )}
      {props.tool === "drainHole" && (
        <div className="pointer-events-none absolute start-1/2 top-3 -translate-x-1/2 rounded-md bg-teal-600/90 px-3 py-1 text-xs text-white shadow">
          לחצו על פני הגוף במקום שבו ייקדח חור הניקוז
        </div>
      )}
      {props.printPreview.enabled && (
        <div className="pointer-events-none absolute bottom-3 start-1/2 -translate-x-1/2 rounded-md bg-slate-800/85 px-3 py-1 text-xs text-white shadow">
          תצוגה מקדימה בלבד — יש לאמת בסלייסר לפני הדפסה.
        </div>
      )}
    </div>
  );
}
