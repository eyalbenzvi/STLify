"use client";

/**
 * Which modal is showing.
 *
 * The editor used to carry one `useState<boolean>` per dialog — seventeen of
 * them — even though the UI only ever shows one at a time. That made
 * "dismiss whatever is open" a seventeen-call chore, which is exactly the
 * thing every operation handler needs to do first.
 *
 * Three dialogs carry a subject rather than just a flag (which boolean
 * operation, which generator, which surface point to drill), so they get
 * their own fields. `close()` clears all of it.
 *
 * Dialogs whose visibility is already implied by data they display —
 * the crash-recovery snapshot, an import preview, an interference report —
 * stay where their data lives and are not tracked here.
 */

import { useCallback, useMemo, useState } from "react";
import type { BooleanOperationKind } from "@/types/design";
import type { GeneratorKind } from "@/lib/geometry/generators/specs";
import type { SurfacePick } from "@/components/viewer/SceneView";

export type DialogName =
  | "cut"
  | "connectors"
  | "hollow"
  | "thicken"
  | "smooth"
  | "simplify"
  | "fillet"
  | "shell"
  | "deform"
  | "lattice"
  | "pattern"
  | "revolve"
  | "emboss"
  | "inspector"
  | "export"
  | "library"
  | "shortcuts";

export interface EditorDialogs {
  isOpen: (name: DialogName) => boolean;
  open: (name: DialogName) => void;
  /** Dismiss whatever is showing, including the subject-carrying dialogs. */
  close: () => void;

  /** Non-null while the boolean dialog is showing, and says which operation. */
  booleanKind: BooleanOperationKind | null;
  openBoolean: (kind: BooleanOperationKind | null) => void;

  /** Non-null while a generator dialog is showing, and says which one. */
  generatorKind: GeneratorKind | null;
  openGenerator: (kind: GeneratorKind | null) => void;

  /** The surface point a drain hole will be drilled at, once confirmed. */
  drainPick: SurfacePick | null;
  setDrainPick: (pick: SurfacePick | null) => void;
}

export function useEditorDialogs(): EditorDialogs {
  const [active, setActive] = useState<DialogName | null>(null);
  const [booleanKind, setBooleanKind] = useState<BooleanOperationKind | null>(null);
  const [generatorKind, setGeneratorKind] = useState<GeneratorKind | null>(null);
  const [drainPick, setDrainPick] = useState<SurfacePick | null>(null);

  const open = useCallback((name: DialogName) => {
    setActive(name);
    setBooleanKind(null);
    setGeneratorKind(null);
  }, []);

  const close = useCallback(() => {
    setActive(null);
    setBooleanKind(null);
    setGeneratorKind(null);
    setDrainPick(null);
  }, []);

  const openBoolean = useCallback((kind: BooleanOperationKind | null) => {
    setActive(null);
    setBooleanKind(kind);
  }, []);

  const openGenerator = useCallback((kind: GeneratorKind | null) => {
    setActive(null);
    setGeneratorKind(kind);
  }, []);

  return useMemo(
    () => ({
      isOpen: (name: DialogName) => active === name,
      open,
      close,
      booleanKind,
      openBoolean,
      generatorKind,
      openGenerator,
      drainPick,
      setDrainPick,
    }),
    [active, open, close, booleanKind, openBoolean, generatorKind, openGenerator, drainPick]
  );
}
