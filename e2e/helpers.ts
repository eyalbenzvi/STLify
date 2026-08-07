/**
 * Shared helpers for the UI regression suite.
 *
 * Two rules the journeys follow:
 *
 *  1. Assert on the MODEL, not on the DOM where possible. The dimension
 *     readout in the viewport is driven by the real geometry pipeline, so
 *     watching it change proves the operation ran — a button that merely
 *     highlights proves nothing.
 *  2. Fail on any console error. Several defects the expert review found
 *     (a panel that throws, an unwired handler) surface as console noise
 *     long before they surface as a visible symptom.
 */

import { expect, type Page } from "@playwright/test";

/** Attach an error collector; call the returned function to assert silence. */
export function watchForErrors(page: Page): () => void {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    // WebGL context warnings from headless GPU emulation are environmental.
    if (/WebGL|GPU stall|Cross-Origin-Opener/i.test(text)) return;
    errors.push(`console: ${text}`);
  });
  return () => expect(errors, "no console or page errors").toEqual([]);
}

/** Open the editor and wait for the initial model to finish building. */
export async function openEditor(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "networkidle" });
  // The readout only appears once the pipeline has produced parts.
  await expect(page.getByTestId("viewport-dimensions")).toBeVisible({ timeout: 60_000 });
}

/**
 * The viewport's live dimension readout, e.g. "120.0 x 40.0 x 4.5 mm".
 *
 * Targeted by test id rather than by scraping the page for a dimension-shaped
 * string: several panels print their own dimensions, and a body-text regex
 * silently picked up whichever appeared first in the DOM.
 */
export async function readDimensions(page: Page): Promise<string> {
  return (await page.getByTestId("viewport-dimensions").innerText()).trim();
}

/** Wait until the dimension readout differs from `previous`. */
export async function waitForModelChange(page: Page, previous: string): Promise<string> {
  await expect
    .poll(async () => readDimensions(page), { timeout: 90_000, intervals: [500] })
    .not.toBe(previous);
  return readDimensions(page);
}

/**
 * Set a NumberField by its exact Hebrew label.
 *
 * Exact matching matters: `has-text("radius")` also matches "corner radius",
 * so a substring selector silently drove the wrong control — a sketch test
 * set a rectangle's corner radius while believing it was resizing a circle.
 */
export async function setNumberField(
  page: Page,
  labelHe: string,
  value: number
): Promise<void> {
  const input = page.getByLabel(labelHe, { exact: true }).first();
  await input.fill(String(value));
  await input.blur();
}

/**
 * Click the centre of the 3D canvas.
 *
 * Hard-coded viewport coordinates are wrong whenever the panel column's width
 * changes: the canvas is not centred in the window, it is centred in what is
 * left after the panels. Asking the element for its own box is stable.
 */
export async function clickViewportCenter(page: Page): Promise<void> {
  const canvas = page.locator("canvas").first();
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas has no bounding box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/** Assert no operation-failure dialog is showing. */
export async function expectNoFailure(page: Page): Promise<void> {
  await expect(page.locator("body")).not.toContainText("הפעולה נכשלה");
}

/**
 * Load the blank template so a test starts from an empty plate.
 *
 * Without this, every assertion competes with the default nameplate: the
 * dimension readout is the UNION of all parts, so resizing a 20mm cube to
 * 65mm changes nothing while a 120mm nameplate is also on the plate. Starting
 * blank makes the readout a direct measurement of what the test built.
 */
export async function startBlank(page: Page): Promise<void> {
  await page.getByLabel("בחירת תבנית").selectOption("blank");
  // The blank template still ships a 100x60 base plate, which would dominate
  // the union readout. Baseless mode drops it from the build, leaving a truly
  // empty plate.
  await page.getByRole("group", { name: "מצב בסיס" }).getByText("ללא בסיס").click();
  const confirm = page.getByRole("button", { name: "עבור מצב" });
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await expect(page.getByTestId("viewport-dimensions")).toBeHidden({ timeout: 30_000 });
}

/** Add the first primitive to an empty document and wait for it to build. */
export async function addFirstPrimitive(page: Page, labelHe: string): Promise<string> {
  await page.getByRole("button", { name: labelHe, exact: true }).click();
  await expect(page.getByTestId("viewport-dimensions")).toBeVisible({ timeout: 60_000 });
  return readDimensions(page);
}

/** Add a primitive from the creation panel and wait for it to build. */
export async function addPrimitive(page: Page, labelHe: string): Promise<void> {
  const before = await readDimensions(page);
  await page.getByRole("button", { name: labelHe, exact: true }).click();
  await waitForModelChange(page, before);
}
