/** The axis picker every geometry dialog shows, in one place. */

import type { Axis } from "@/types/design";

export const AXIS_OPTIONS: { value: Axis; label: string }[] = [
  { value: "x", label: "X" },
  { value: "y", label: "Y" },
  { value: "z", label: "Z" },
];
