/**
 * Local design library journey (V6 item 16).
 *
 * The DoD journey, end to end in a real browser: save a design, RELOAD THE
 * PAGE (IndexedDB must survive it — that is the whole point), load the
 * design back, revert to an earlier version, and finally delete everything.
 * Every step asserts a GEOMETRY consequence through the dimension readout,
 * not a DOM state.
 */

import { expect, test } from "@playwright/test";
import {
  addFirstPrimitive,
  openEditor,
  readDimensions,
  setNumberField,
  startBlank,
  waitForModelChange,
  watchForErrors,
} from "./helpers";

test.describe("design library", () => {
  test("save, refresh, load, revert to a version, delete everything", async ({ page }) => {
    const assertSilent = watchForErrors(page);
    await openEditor(page);
    await startBlank(page);
    await addFirstPrimitive(page, "תיבה");

    // Version 1: a 42mm-wide box.
    let dims = await readDimensions(page);
    await setNumberField(page, "רוחב (X)", 42);
    dims = await waitForModelChange(page, dims);
    expect(dims).toContain("42.0");

    await page.getByRole("button", { name: "ספרייה", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("שם העיצוב").fill("בדיקת ספרייה");
    await dialog.getByRole("button", { name: "שמירת העיצוב הנוכחי" }).click();
    await expect(dialog.getByTestId("library-design")).toHaveCount(1);
    await expect(dialog).toContainText("בדיקת ספרייה");
    await expect(dialog).toContainText("גרסה 1");

    // Version 2: resize to 60 and save a version onto the same design.
    await dialog.getByRole("button", { name: "סגירה", exact: true }).last().click();
    await setNumberField(page, "רוחב (X)", 60);
    dims = await waitForModelChange(page, dims);
    expect(dims).toContain("60.0");
    await page.getByRole("button", { name: "ספרייה", exact: true }).click();
    await dialog.getByRole("button", { name: "שמירת גרסה" }).click();
    await expect(dialog).toContainText("גרסה 2");
    await dialog.getByRole("button", { name: "סגירה", exact: true }).last().click();

    // RELOAD — the library must survive the session.
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByTestId("viewport-dimensions")).toBeVisible({ timeout: 60_000 });

    // Load the design (latest version): the 60mm box replaces the default
    // nameplate document.
    await page.getByRole("button", { name: "ספרייה", exact: true }).click();
    await expect(dialog.getByTestId("library-design")).toHaveCount(1);
    await dialog.getByRole("button", { name: "טעינה", exact: true }).click();
    await expect
      .poll(async () => readDimensions(page), { timeout: 60_000 })
      .toContain("60.0");

    // Revert to version 1: the 42mm box.
    await page.getByRole("button", { name: "ספרייה", exact: true }).click();
    await dialog.getByRole("button", { name: "גרסאות" }).click();
    await expect(dialog.getByTestId("library-version")).toHaveCount(2);
    await dialog
      .getByTestId("library-version")
      .filter({ hasText: "גרסה 1" })
      .getByRole("button", { name: "שחזור גרסה זו" })
      .click();
    await expect
      .poll(async () => readDimensions(page), { timeout: 60_000 })
      .toContain("42.0");

    // Delete everything — the library is empty and stays empty after the
    // dialog reopens (i.e., it really was removed from IndexedDB).
    await page.getByRole("button", { name: "ספרייה", exact: true }).click();
    await dialog.getByRole("button", { name: "מחיקת כל הספרייה" }).click();
    await expect(dialog.getByTestId("library-design")).toHaveCount(0);
    await dialog.getByRole("button", { name: "סגירה", exact: true }).last().click();
    await page.getByRole("button", { name: "ספרייה", exact: true }).click();
    await expect(dialog.getByTestId("library-design")).toHaveCount(0);
    await expect(dialog).toContainText("הספרייה ריקה");

    assertSilent();
  });
});
