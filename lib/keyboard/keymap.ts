/**
 * Editor keyboard map (V6 item 18): the standard 3D-tool shortcuts, an
 * EDITABLE mapping persisted locally, and the plumbing the help screen
 * uses to display and re-bind them.
 *
 * The mapping lives in localStorage on this device — consistent with the
 * charter: no accounts, no sync. Unknown or partial stored data merges
 * over the defaults, so an old saved map survives new actions.
 */

export interface KeyBinding {
  /** KeyboardEvent.code — layout-independent physical key. */
  code: string;
  ctrl?: boolean;
  shift?: boolean;
}

export type KeyActionId =
  | "undo"
  | "redo"
  | "delete"
  | "toolSelect"
  | "toolTranslate"
  | "toolRotate"
  | "toolScale"
  | "frameSelection"
  | "duplicate"
  | "selectAll"
  | "viewTop"
  | "viewFront"
  | "viewSide"
  | "viewIso"
  | "shortcutHelp";

export interface KeyActionInfo {
  id: KeyActionId;
  nameHe: string;
  /** Editable from the help screen; core edit keys stay fixed. */
  editable: boolean;
}

export const KEY_ACTIONS: KeyActionInfo[] = [
  { id: "undo", nameHe: "ביטול (Undo)", editable: false },
  { id: "redo", nameHe: "ביצוע מחדש (Redo)", editable: false },
  { id: "delete", nameHe: "מחיקת הבחירה", editable: false },
  { id: "toolSelect", nameHe: "כלי בחירה", editable: true },
  { id: "toolTranslate", nameHe: "כלי הזזה", editable: true },
  { id: "toolRotate", nameHe: "כלי סיבוב", editable: true },
  { id: "toolScale", nameHe: "כלי קנה מידה", editable: true },
  { id: "frameSelection", nameHe: "מסגור הבחירה בתצוגה", editable: true },
  { id: "duplicate", nameHe: "שכפול הבחירה", editable: true },
  { id: "selectAll", nameHe: "בחירת הכול", editable: true },
  { id: "viewTop", nameHe: "מבט מלמעלה", editable: true },
  { id: "viewFront", nameHe: "מבט מלפנים", editable: true },
  { id: "viewSide", nameHe: "מבט מהצד", editable: true },
  { id: "viewIso", nameHe: "מבט איזומטרי", editable: true },
  { id: "shortcutHelp", nameHe: "מסך קיצורי המקלדת", editable: true },
];

export type Keymap = Record<KeyActionId, KeyBinding>;

export const DEFAULT_KEYMAP: Keymap = {
  undo: { code: "KeyZ", ctrl: true },
  redo: { code: "KeyY", ctrl: true },
  delete: { code: "Delete" },
  toolSelect: { code: "KeyQ" },
  toolTranslate: { code: "KeyG" },
  toolRotate: { code: "KeyR" },
  toolScale: { code: "KeyS" },
  frameSelection: { code: "KeyF" },
  duplicate: { code: "KeyD", ctrl: true },
  selectAll: { code: "KeyA", ctrl: true },
  viewTop: { code: "Digit7" },
  viewFront: { code: "Digit1" },
  viewSide: { code: "Digit3" },
  viewIso: { code: "Digit0" },
  shortcutHelp: { code: "Slash", shift: true },
};

const STORAGE_KEY = "printcraft-keymap";

/** Load the stored keymap merged over the defaults. */
export function loadKeymap(): Keymap {
  if (typeof localStorage === "undefined") return { ...DEFAULT_KEYMAP };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_KEYMAP };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const merged: Keymap = { ...DEFAULT_KEYMAP };
    for (const action of KEY_ACTIONS) {
      const value = parsed[action.id];
      if (
        value &&
        typeof value === "object" &&
        typeof (value as KeyBinding).code === "string" &&
        (value as KeyBinding).code.length > 0 &&
        (value as KeyBinding).code.length < 32
      ) {
        const binding = value as KeyBinding;
        merged[action.id] = {
          code: binding.code,
          ctrl: binding.ctrl === true || undefined,
          shift: binding.shift === true || undefined,
        };
      }
    }
    return merged;
  } catch {
    return { ...DEFAULT_KEYMAP };
  }
}

export function saveKeymap(keymap: Keymap): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(keymap));
  } catch {
    // Best effort — the session keeps the in-memory map.
  }
}

export function resetKeymap(): Keymap {
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // fall through
    }
  }
  return { ...DEFAULT_KEYMAP };
}

/** True when the event matches the binding (meta counts as ctrl on Mac). */
export function bindingMatches(event: KeyboardEvent, binding: KeyBinding): boolean {
  if (event.code !== binding.code) return false;
  const withCtrl = event.ctrlKey || event.metaKey;
  if (Boolean(binding.ctrl) !== withCtrl) return false;
  if (Boolean(binding.shift) !== event.shiftKey) return false;
  return true;
}

/**
 * The action an event triggers, or null. Undo/redo get their historical
 * special case: Ctrl+Shift+Z is redo everywhere.
 */
export function actionForEvent(event: KeyboardEvent, keymap: Keymap): KeyActionId | null {
  if ((event.ctrlKey || event.metaKey) && event.code === "KeyZ") {
    return event.shiftKey ? "redo" : "undo";
  }
  for (const action of KEY_ACTIONS) {
    if (bindingMatches(event, keymap[action.id])) return action.id;
  }
  // Backspace deletes too (the pre-V6 behaviour).
  if (event.code === "Backspace" && !event.ctrlKey && !event.metaKey) return "delete";
  return null;
}

/** Human-readable label of a binding, e.g. "Ctrl+Shift+F". */
export function formatBinding(binding: KeyBinding): string {
  const key = binding.code
    .replace(/^Key/, "")
    .replace(/^Digit/, "")
    .replace(/^Numpad/, "Num ");
  const parts: string[] = [];
  if (binding.ctrl) parts.push("Ctrl");
  if (binding.shift) parts.push("Shift");
  parts.push(key === "Slash" ? "?" : key);
  return parts.join("+");
}

/** Build a binding from a captured keydown; null for pure modifier presses. */
export function bindingFromEvent(event: KeyboardEvent): KeyBinding | null {
  if (["ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"].includes(event.code)) {
    return null;
  }
  return {
    code: event.code,
    ctrl: event.ctrlKey || event.metaKey || undefined,
    shift: event.shiftKey || undefined,
  };
}
