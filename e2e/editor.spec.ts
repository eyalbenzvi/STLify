/**
 * Critical user journeys.
 *
 * Each test drives the real app and asserts a consequence in the geometry
 * pipeline. They exist to catch the failure mode the unit tests structurally
 * cannot see: an engine that works perfectly but is not connected to
 * anything.
 */

import { expect, test } from "@playwright/test";
import {
  addFirstPrimitive,
  addPrimitive,
  clickViewportCenter,
  expectNoFailure,
  openEditor,
  readDimensions,
  setNumberField,
  startBlank,
  waitForModelChange,
  watchForErrors,
} from "./helpers";

test.describe("editor boot", () => {
  test("loads with a working model and no errors", async ({ page }) => {
    const assertSilent = watchForErrors(page);
    await openEditor(page);
    await expect(page.locator("body")).toContainText("יצירה");
    await expect(page.locator("body")).toContainText("שכבות");
    await expect(page.locator("body")).toContainText("כלים");
    assertSilent();
  });
});

test.describe("creation and editing", () => {
  test("a primitive can be created and then resized", async ({ page }) => {
    const assertSilent = watchForErrors(page);
    await openEditor(page);
    await startBlank(page);
    const created = await addFirstPrimitive(page, "תיבה");
    expect(created).toContain("20.0 × 20.0 × 20.0");

    // The properties panel must offer the primitive's own parameters.
    await expect(page.locator("body")).toContainText("סוג הגוף");
    await expect(page.locator("body")).toContainText("רוחב (X)");

    await setNumberField(page, "רוחב (X)", 65);
    const after = await waitForModelChange(page, created);
    expect(after).toContain("65.0 × 20.0 × 20.0");
    await expectNoFailure(page);
    assertSilent();
  });

  test("changing a primitive's kind rebuilds it", async ({ page }) => {
    await openEditor(page);
    await startBlank(page);
    await addFirstPrimitive(page, "תיבה");
    await page.locator('label:has-text("סוג הגוף") select').selectOption("sphere");
    // The panel must swap to the sphere's own parameter set.
    await expect(page.locator("body")).toContainText("רדיוס");
    await expect(page.locator("body")).not.toContainText("רוחב (X)");

    // A default sphere (r=10) has the same 20mm bounding box as the default
    // cube, so the readout alone would not prove a rebuild. Resizing does.
    const before = await readDimensions(page);
    await setNumberField(page, "רדיוס", 35);
    const after = await waitForModelChange(page, before);
    expect(after).not.toBe(before);
    await expectNoFailure(page);
  });

  test("a sketch entity can be added and edited", async ({ page }) => {
    await openEditor(page);
    await startBlank(page);
    await addFirstPrimitive(page, "סקיצה");
    await expect(page.locator("body")).toContainText("צורות בסקיצה");

    await page.getByLabel("הוספת צורה לסקיצה").selectOption("circle");
    await expect(page.locator("body")).toContainText("עיגול");

    // The new circle (r=8) sits inside the seeded 30x20 rectangle, so the
    // sketch's extent only changes once the circle grows past it.
    const before = await readDimensions(page);
    await setNumberField(page, "רדיוס", 45);
    const after = await waitForModelChange(page, before);
    expect(after).toContain("90.0");
    await expectNoFailure(page);
  });

  test("a parametric generator produces a part", async ({ page }) => {
    const assertSilent = watchForErrors(page);
    await openEditor(page);
    const before = await readDimensions(page);
    await page.getByRole("button", { name: "גלגל שיניים" }).click();
    await page.getByRole("button", { name: "צור" }).click();
    await waitForModelChange(page, before);
    await expect(page.locator("body")).toContainText(/גלגל שיניים \d+Z/);
    await expectNoFailure(page);
    assertSilent();
  });

  test("an array pattern multiplies the selection", async ({ page }) => {
    await openEditor(page);
    await addPrimitive(page, "תיבה");
    const before = await readDimensions(page);
    await page.getByRole("button", { name: "מערך עותקים" }).click();
    await page.getByRole("button", { name: "צור" }).click();
    await waitForModelChange(page, before);
    await expectNoFailure(page);
  });
});

test.describe("sub-object editing", () => {
  test("a face can be picked and pushed", async ({ page }) => {
    const assertSilent = watchForErrors(page);
    await openEditor(page);
    await startBlank(page);
    await addFirstPrimitive(page, "תיבה");

    await page.getByRole("button", { name: "הפעל בחירת פאות" }).click();
    await expect(page.locator("body")).toContainText("אופן הבחירה");

    // Click the canvas centre, where the freshly added body sits.
    await clickViewportCenter(page);
    await expect(page.locator("body")).toContainText(/נבחרו \d+ משולשים/);
    // A box face is coplanar, so push/pull must be offered.
    await expect(page.locator("body")).toContainText("מישורית");

    const before = await readDimensions(page);
    await page.getByRole("button", { name: "הזז פאה" }).click();
    await waitForModelChange(page, before);
    await expectNoFailure(page);
    assertSilent();
  });

  test("leaving face mode clears the selection", async ({ page }) => {
    await openEditor(page);
    await startBlank(page);
    await addFirstPrimitive(page, "תיבה");
    await page.getByRole("button", { name: "הפעל בחירת פאות" }).click();
    await clickViewportCenter(page);
    await expect(page.locator("body")).toContainText(/נבחרו \d+ משולשים/);
    await page.getByRole("button", { name: /מצב בחירת פאות פעיל/ }).click();
    await expect(page.locator("body")).not.toContainText(/נבחרו \d+ משולשים/);
  });
});

test.describe("parametric editing", () => {
  test("a parameter evaluates live and reports a bad expression", async ({ page }) => {
    await openEditor(page);
    await page.getByRole("button", { name: "+ פרמטר" }).click();
    await page.getByLabel("שם הפרמטר").first().fill("wall");

    await page.getByRole("button", { name: "+ פרמטר" }).click();
    const expressions = page.locator('input[placeholder*="ביטוי"]');
    await expressions.nth(1).fill("wall * 3");
    // Default parameter value is 10.
    await expect(page.locator("body")).toContainText("30.000");

    await expressions.nth(1).fill("nope * 2");
    await expect(page.locator("body")).toContainText("פרמטר לא מוכר");
  });

  test("a modifier can be added, disabled and removed", async ({ page }) => {
    const assertSilent = watchForErrors(page);
    await openEditor(page);
    await startBlank(page);
    await addFirstPrimitive(page, "תיבה");
    await expect(page.locator("body")).toContainText("מודיפיירים");

    // Twist, not taper: a taper keeps the base footprint, so it is invisible
    // in a bounding box. Twisting sweeps the corners outward measurably.
    const before = await readDimensions(page);
    await page.getByLabel("הוספת מודיפייר").selectOption("twist");
    const twisted = await waitForModelChange(page, before);
    await expect(page.locator("body")).toContainText("פיתול");

    // Disabling must restore the original body exactly — that is what proves
    // the stack is re-derived from the source rather than baked into it.
    await page.getByLabel("הפעלת פיתול").uncheck();
    const restored = await waitForModelChange(page, twisted);
    expect(restored).toBe(before);
    await expectNoFailure(page);
    assertSilent();
  });
});

test.describe("history", () => {
  test("clicking a history entry travels back", async ({ page }) => {
    await openEditor(page);
    await addPrimitive(page, "תיבה");
    const withBox = await readDimensions(page);

    // The oldest entry in the list is the original document state.
    const entries = page.locator("ol li button");
    await entries.first().click();
    const reverted = await waitForModelChange(page, withBox);
    expect(reverted).not.toBe(withBox);
  });
});

test.describe("analysis and repair", () => {
  test("interference detection reports a verdict", async ({ page }) => {
    await openEditor(page);
    await addPrimitive(page, "תיבה");
    await page.getByRole("button", { name: "בדיקת חדירה" }).click();
    await expect(page.locator("body")).toContainText(/נבדקו \d+ זוגות|נמצאו \d+ זוגות/);
    await page.getByRole("button", { name: "סגור" }).click();
  });

  test("auto-arrange lays parts out", async ({ page }) => {
    await openEditor(page);
    await addPrimitive(page, "תיבה");
    await page.getByRole("button", { name: "סידור על המשטח" }).click();
    await expect(page.locator("body")).toContainText(/חלקים סודרו/);
  });
});

test.describe("export", () => {
  test("an STL can be downloaded", async ({ page }) => {
    await openEditor(page);
    await startBlank(page);
    await addFirstPrimitive(page, "תיבה");

    await page.getByRole("button", { name: "ייצוא ⬇" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Scope to the dialog: the header has its own "export" button, and the
    // modal backdrop swallows clicks aimed at anything behind it.
    const download = page.waitForEvent("download", { timeout: 60_000 });
    await dialog.getByRole("button", { name: "ייצוא", exact: true }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.stl$/i);
  });

  test("export is blocked when the geometry is unusable", async ({ page }) => {
    await openEditor(page);
    await startBlank(page);
    // No parts at all: exporting geometry must not be offered.
    await page.getByRole("button", { name: "ייצוא ⬇" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: "ייצוא", exact: true })).toBeDisabled();
  });
});
