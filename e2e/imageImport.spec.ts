/**
 * Image import: the manual mask brush.
 *
 * The brush exists because automatic separation fails on real scans and the
 * dialog previously offered nothing when it did. A DOM assertion could only
 * show that a canvas accepted a pointer; what matters is whether the stroke
 * reaches the geometry, so this journey measures the built solid before and
 * after the correction.
 */

import { expect, test } from "@playwright/test";
import { encodePng, fillRect } from "./png";
import { openEditor, readDimensions, startBlank, watchForErrors } from "./helpers";

const SIZE = 200;
/** The artwork the user wants: a square in the middle. */
const SUBJECT = { x0: 70, y0: 70, x1: 130, y1: 130 };
/** What the scanner also picked up: a mark in the corner, far from it. */
const SMUDGE = { x0: 8, y0: 8, x1: 30, y1: 30 };

function artworkWithSmudge(): Buffer {
  const rgb = new Uint8Array(SIZE * SIZE * 3).fill(245);
  fillRect(rgb, SIZE, SUBJECT, [20, 20, 30]);
  fillRect(rgb, SIZE, SMUDGE, [25, 25, 35]);
  return encodePng(SIZE, SIZE, rgb);
}

/** Open the image dialog on the generated artwork and wait for the preview. */
async function importArtwork(page: import("@playwright/test").Page) {
  await page.getByLabel("קובץ תמונה").setInputFiles({
    name: "scan.png",
    mimeType: "image/png",
    buffer: artworkWithSmudge(),
  });
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const canvas = dialog.getByTestId("mask-brush-canvas");
  // Wait for the decode to land, and wait for it properly: a fresh <canvas>
  // reports width 300 before anything is drawn, so "width > 2" passes
  // instantly and the drag then arrives while the brush is still inert.
  await expect(dialog.getByText("מכין תצוגה מקדימה")).toBeHidden({ timeout: 30_000 });
  await expect
    .poll(
      async () => canvas.evaluate((element: HTMLCanvasElement) => element.width),
      { timeout: 30_000 }
    )
    .toBe(SIZE);
  return { dialog, canvas };
}

/** "40.5 x 40.5 x 3.0 mm" → 40.5, the largest footprint dimension. */
function footprint(readout: string): number {
  const numbers = readout.match(/[\d.]+/g)?.map(Number) ?? [];
  return Math.max(numbers[0] ?? 0, numbers[1] ?? 0);
}

test.describe("image import", () => {
  test("brushing the mask changes the built solid", async ({ page }) => {
    const assertSilent = watchForErrors(page);
    await openEditor(page);
    await startBlank(page);

    // 1. Import as the automatic path sees it: the smudge is dark, so it
    //    becomes a second body and stretches the part across the plate.
    await importArtwork(page);
    await page.getByRole("button", { name: "צור גוף" }).click();
    await expect(page.getByTestId("viewport-dimensions")).toBeVisible({ timeout: 60_000 });
    const withSmudge = footprint(await readDimensions(page));
    // Content spans 8..130 of 200 px at 60 mm wide → around 37 mm.
    expect(withSmudge).toBeGreaterThan(30);

    // 2. Undo back to the empty plate.
    await page.getByRole("button", { name: "ביטול", exact: true }).click();
    await expect(page.getByTestId("viewport-dimensions")).toBeHidden({ timeout: 30_000 });

    // 3. Import again, this time erasing the smudge with the brush.
    const { dialog, canvas } = await importArtwork(page);
    // A brush wide enough to swallow the mark in one pass: 12% of the image's
    // larger side is 24 px, and the mark is 22 px across.
    const brush = dialog.getByLabel("גודל מברשת", { exact: true });
    await brush.fill("12");
    await brush.blur();

    // Positions are ELEMENT-relative: the dialog scrolls, so a page-absolute
    // box taken up front can be stale by the time the drag runs, and the
    // press then lands on whatever is at those coordinates instead.
    const css = await canvas.evaluate((element: HTMLCanvasElement) => ({
      width: element.clientWidth,
      height: element.clientHeight,
    }));
    const at = (x: number, y: number) => ({
      x: (css.width * x) / SIZE,
      y: (css.height * y) / SIZE,
    });
    // Default brush mode is erase; drag down the middle of the corner mark.
    const midX = (SMUDGE.x0 + SMUDGE.x1) / 2;
    await canvas.hover({ position: at(midX, SMUDGE.y0 + 2) });
    await page.mouse.down();
    await canvas.hover({ position: at(midX, (SMUDGE.y0 + SMUDGE.y1) / 2) });
    await canvas.hover({ position: at(midX, SMUDGE.y1 - 2) });
    await page.mouse.up();
    await expect(dialog).toContainText("1 משיחות");

    await page.getByRole("button", { name: "צור גוף" }).click();
    await expect(page.getByTestId("viewport-dimensions")).toBeVisible({ timeout: 60_000 });
    const brushed = footprint(await readDimensions(page));

    // The geometry consequence: only the 60 px subject survives, which at
    // 60 mm across a 200 px image is about 18 mm.
    expect(brushed).toBeLessThan(withSmudge - 8);
    expect(brushed).toBeGreaterThan(10);
    assertSilent();
  });
});
