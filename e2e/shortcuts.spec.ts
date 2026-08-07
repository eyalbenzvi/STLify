/**
 * 3D-tool keyboard shortcuts (V6 item 18).
 *
 * Every NEW shortcut gets a journey that asserts its CONSEQUENCE: a camera
 * move changes the viewport pixels, Ctrl+D adds a real part, Ctrl+A arms
 * a delete of everything, remapping actually re-binds and persists across
 * a reload — and the input-focus guard keeps typing in a field from
 * triggering tools.
 */

import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  addFirstPrimitive,
  openEditor,
  readDimensions,
  startBlank,
  watchForErrors,
} from "./helpers";

async function viewportHash(page: Page): Promise<string> {
  const canvas = page.locator("canvas").first();
  const shot = await canvas.screenshot({ animations: "disabled" });
  return createHash("sha1").update(shot).digest("hex");
}

async function expectRepaint(page: Page, before: string, label: string): Promise<string> {
  await expect
    .poll(async () => viewportHash(page), {
      timeout: 30_000,
      intervals: [250, 500],
      message: `viewport must change after: ${label}`,
    })
    .not.toBe(before);
  return viewportHash(page);
}

test.describe("keyboard shortcuts", () => {
  test("F frames the selection and 7/1/3/0 switch views", async ({ page }) => {
    const assertSilent = watchForErrors(page);
    await openEditor(page);
    await startBlank(page);
    await addFirstPrimitive(page, "תיבה");
    let last = await viewportHash(page);

    await page.keyboard.press("KeyF");
    last = await expectRepaint(page, last, "F frame selection");

    await page.keyboard.press("Digit7");
    last = await expectRepaint(page, last, "top view");
    await page.keyboard.press("Digit1");
    last = await expectRepaint(page, last, "front view");
    await page.keyboard.press("Digit3");
    last = await expectRepaint(page, last, "side view");
    await page.keyboard.press("Digit0");
    await expectRepaint(page, last, "iso view");
    assertSilent();
  });

  test("Ctrl+D duplicates and Ctrl+A selects everything", async ({ page }) => {
    await openEditor(page);
    await startBlank(page);
    await addFirstPrimitive(page, "תיבה");

    // Duplicate: a second REAL part appears in the pipeline readout.
    await page.keyboard.press("Control+d");
    await expect(page.getByTestId("viewport-dimensions")).toContainText("2 parts", {
      timeout: 60_000,
    });

    // Select all + Delete: everything goes, the readout disappears (an
    // empty document has no dimensions).
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Delete");
    await expect(page.getByTestId("viewport-dimensions")).toBeHidden({ timeout: 60_000 });
  });

  test("Shift+? opens the help screen; remapping persists across a reload", async ({ page }) => {
    await openEditor(page);
    await startBlank(page);
    await addFirstPrimitive(page, "תיבה");

    await page.keyboard.press("Shift+Slash");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("קיצורי מקלדת");
    await expect(dialog.getByTestId("shortcut-row")).toHaveCount(15);

    // Remap the translate tool from G to T.
    await dialog.getByLabel("שינוי קיצור: כלי הזזה").click();
    await page.keyboard.press("KeyT");
    await expect(dialog).toContainText("T");
    await dialog.getByRole("button", { name: "סגירה", exact: true }).last().click();

    // The NEW key activates the tool…
    const translateButton = page
      .getByRole("toolbar", { name: "כלי טרנספורמציה" })
      .getByRole("button", { name: "הזזה", exact: true });
    await page.keyboard.press("KeyT");
    await expect(translateButton).toHaveAttribute("aria-pressed", "true");

    // …and survives a reload (stored locally).
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByTestId("viewport-dimensions")).toBeVisible({ timeout: 60_000 });
    await page.keyboard.press("KeyT");
    await expect(
      page
        .getByRole("toolbar", { name: "כלי טרנספורמציה" })
        .getByRole("button", { name: "הזזה", exact: true })
    ).toHaveAttribute("aria-pressed", "true");
  });

  test("shortcuts are ignored while typing in a field", async ({ page }) => {
    await openEditor(page);
    await startBlank(page);
    await addFirstPrimitive(page, "תיבה");
    const dims = await readDimensions(page);

    // Type letters that ARE tool/delete shortcuts into a text field.
    const widthField = page.getByLabel("רוחב (X)", { exact: true }).first();
    await widthField.click();
    await page.keyboard.press("KeyG");
    await page.keyboard.press("KeyF");
    await page.keyboard.press("Delete");

    // No tool changed and nothing was deleted.
    await expect(
      page
        .getByRole("toolbar", { name: "כלי טרנספורמציה" })
        .getByRole("button", { name: "הזזה", exact: true })
    ).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("viewport-dimensions")).toBeVisible();
    expect(await readDimensions(page)).toBe(dims);
  });
});
