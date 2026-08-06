"use client";

/**
 * Properties editor for the selected layer: layer-specific controls plus the
 * shared transform / colour / colour-slot sections.
 */

import type { BaseLayer, DesignLayer } from "@/types/design";
import { updateLayer, useEditorStore } from "@/lib/design/store";
import { pushRecentColor } from "@/lib/design/sessionPrefs";
import { BaseLayerControls } from "./BaseLayerControls";
import { TextLayerControls } from "./TextLayerControls";
import { SvgLayerControls } from "./SvgLayerControls";
import { ImageLayerControls } from "./ImageLayerControls";
import { HoleLayerControls } from "./HoleLayerControls";
import { TransformControls, type PartBounds } from "./TransformControls";
import { ColorSwatchPicker } from "./ColorSwatchPicker";

interface LayerPropertiesProps {
  layer: DesignLayer;
  bounds: PartBounds | null;
}

export function LayerProperties({ layer, bounds }: LayerPropertiesProps) {
  const { state } = useEditorStore();
  const base = state.doc.layers[0] as BaseLayer;
  const multiColor = state.settings.multiColor;

  if (layer.locked) {
    return (
      <p className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-500">
        🔒 השכבה נעולה לעריכה. שחררו את הנעילה בפאנל השכבות כדי לערוך.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {layer.type === "base" && <BaseLayerControls layer={layer} />}
      {layer.type === "text" && (
        <TextLayerControls layer={layer} multiColorEnabled={multiColor.enabled} />
      )}
      {layer.type === "svg" && (
        <SvgLayerControls layer={layer} multiColorEnabled={multiColor.enabled} />
      )}
      {layer.type === "imageRelief" && <ImageLayerControls layer={layer} />}
      {layer.type === "hole" && <HoleLayerControls layer={layer} />}

      {layer.type !== "base" && (
        <section>
          <h3 className="mb-2 text-xs font-bold text-slate-500">מיקום וגודל</h3>
          <TransformControls layer={layer} base={base} bounds={bounds} />
        </section>
      )}

      {layer.type !== "hole" && (
        <section>
          <h3 className="mb-2 text-xs font-bold text-slate-500">צבע תצוגה</h3>
          <ColorSwatchPicker
            value={layer.colorHex}
            onChange={(colorHex) => {
              pushRecentColor(colorHex);
              updateLayer(layer.id, { colorHex }, { coalesceKey: `color:${layer.id}` });
            }}
          />
          {multiColor.enabled && (
            <label className="mt-3 flex items-center justify-between gap-2 text-sm">
              <span className="text-slate-600">משבצת צבע להדפסה</span>
              <select
                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
                value={layer.colorSlot}
                onChange={(e) => updateLayer(layer.id, { colorSlot: Number(e.target.value) })}
              >
                {multiColor.slots.map((slot, i) => (
                  <option key={i} value={i}>
                    {slot.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </section>
      )}
    </div>
  );
}
