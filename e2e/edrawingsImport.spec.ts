/**
 * eDrawings import: file → import screen → layers.
 *
 * The decoder is covered by unit tests against the same synthetic writer;
 * what only a browser shows is the WIRING — that the model picker hands an
 * .easm to the import screen, that the screen's choices (component, scale,
 * rights confirmation) reach the import, and that the result lands in the
 * document at the size those choices imply.
 */

import { expect, test } from "@playwright/test";
import { boxBody, buildEDrawingsFixture } from "../lib/testing/edrawingsFixture";
import { openEditor, readDimensions, startBlank, watchForErrors } from "./helpers";

/** Two 10 cm cubes, the second one metre along X. */
async function twoCubeAssembly(): Promise<Buffer> {
  const bytes = await buildEDrawingsFixture({
    bodies: [boxBody([0, 0, 0], [0.1, 0.1, 0.1], [40, 120, 200])],
    components: [
      { name: "Cube-1", bodies: [0] },
      { name: "Cube-2", bodies: [0], matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0] },
      { name: "Hidden-1", bodies: [0], matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0], hidden: true },
    ],
    massVolumeM3: 0.003,
  });
  return Buffer.from(bytes);
}

/** "110.0 × 10.0 × 10.0 mm" → [110, 10, 10]. */
function dimensions(readout: string): number[] {
  return (readout.match(/[\d.]+/g) ?? []).map(Number);
}

test.describe("eDrawings import", () => {
  test("an assembly goes through the import screen into scaled layers", async ({ page }) => {
    const assertSilent = watchForErrors(page);
    await openEditor(page);
    await startBlank(page);

    await page.getByLabel("קובץ מודל").setInputFiles({
      name: "assembly.easm",
      mimeType: "application/octet-stream",
      buffer: await twoCubeAssembly(),
    });

    const screen = page.getByTestId("edrawings-screen");
    await expect(screen).toBeVisible({ timeout: 60_000 });
    await expect(screen).toContainText("Cube-1");
    await expect(screen).toContainText("מוסתר בקובץ");
    // Units were checked against the file's own mass properties.
    await expect(screen).toContainText("אומת מול נתוני המסה");
    // The hidden component starts unselected.
    await expect(screen.getByRole("checkbox", { name: /Hidden-1/ })).not.toBeChecked();

    // Nothing can be imported until the rights confirmation is ticked.
    const importButton = screen.getByRole("button", { name: /ייבוא לעורך/ });
    await expect(importButton).toBeDisabled();
    await screen.getByLabel("קנה מידה").selectOption("0.1");
    await expect(page.getByTestId("edrawings-size")).toContainText("110");
    await screen.getByRole("checkbox", { name: /אני מאשר/ }).check();
    await importButton.click();

    const notice = page.getByRole("dialog");
    await expect(notice).toContainText("יובאו 2 רכיבים", { timeout: 60_000 });
    await notice.getByRole("button", { name: "הבנתי" }).click();

    await expect(page.getByTestId("viewport-dimensions")).toBeVisible({ timeout: 60_000 });
    const size = dimensions(await readDimensions(page));
    // 10 cm cubes at 1:10 are 10 mm; the second sits 1 m → 100 mm along X.
    expect(size[0]).toBeCloseTo(110, 0);
    expect(size[1]).toBeCloseTo(10, 0);
    expect(size[2]).toBeCloseTo(10, 0);
    assertSilent();
  });

  test("a 2D drawing is explained rather than imported", async ({ page }) => {
    await openEditor(page);
    await page.getByLabel("קובץ מודל").setInputFiles({
      name: "sheet.edrw",
      mimeType: "application/octet-stream",
      buffer: Buffer.from([1, 2, 3]),
    });
    await expect(page.getByRole("dialog")).toContainText("שרטוטים דו־ממדיים");
  });
});
