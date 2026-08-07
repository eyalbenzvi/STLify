/**
 * Phone and tablet journeys (V6 item 19).
 *
 * The core flow — create, select by TAP, activate a tool, edit a value —
 * driven at real mobile viewports with touch enabled. Assertions follow
 * the house rule: geometry consequences (dimension readout, canvas
 * pixels), not DOM state. RTL stays intact: the layout uses only
 * start-/end- utilities, and these journeys run in the same RTL document.
 */

import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  openEditor,
  readDimensions,
  setNumberField,
  startBlank,
  waitForModelChange,
  watchForErrors,
} from "./helpers";

async function viewportHash(page: Page): Promise<string> {
  const canvas = page.locator("canvas").first();
  const shot = await canvas.screenshot({ animations: "disabled" });
  return createHash("sha1").update(shot).digest("hex");
}

async function tapCanvasCenter(page: Page): Promise<void> {
  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas has no bounding box");
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

function coreJourney() {
  test("create → collapse the drawer → tap-select → tool → numeric edit", async ({ page }) => {
    const assertSilent = watchForErrors(page);
    await openEditor(page);
    await startBlank(page);

    // Create a box from the (open) tool sheet.
    await page.getByRole("button", { name: "תיבה", exact: true }).click();
    await expect(page.getByTestId("viewport-dimensions")).toBeVisible({ timeout: 60_000 });
    const created = await readDimensions(page);
    expect(created).toContain("20.0");

    // Collapse the drawer: the viewport grows to (almost) full height.
    const canvas = page.locator("canvas").first();
    const before = (await canvas.boundingBox())!.height;
    await page.getByTestId("panel-toggle").click();
    await expect(page.getByTestId("panel-drawer")).toBeHidden();
    await expect
      .poll(async () => (await canvas.boundingBox())!.height)
      .toBeGreaterThan(before * 1.2);

    // TAP on empty space deselects (the creation auto-selected the box), and
    // a tap on the body re-selects it — both through the touch pick path,
    // both asserted on the pixels.
    const canvasBox = (await canvas.boundingBox())!;
    const beforeDeselect = await viewportHash(page);
    await page.touchscreen.tap(canvasBox.x + canvasBox.width * 0.9, canvasBox.y + 30);
    await expect
      .poll(async () => viewportHash(page), { timeout: 30_000 })
      .not.toBe(beforeDeselect);
    const beforeTap = await viewportHash(page);
    await tapCanvasCenter(page);
    await expect
      .poll(async () => viewportHash(page), { timeout: 30_000 })
      .not.toBe(beforeTap);

    // Reopen the drawer, switch to the translate tool (gizmo appears).
    await page.getByTestId("panel-toggle").click();
    await expect(page.getByTestId("panel-drawer")).toBeVisible();
    const beforeGizmo = await viewportHash(page);
    await page
      .getByRole("toolbar", { name: "כלי טרנספורמציה" })
      .getByRole("button", { name: "הזזה", exact: true })
      .click();
    await expect
      .poll(async () => viewportHash(page), { timeout: 30_000 })
      .not.toBe(beforeGizmo);

    // Numeric edit still flows into real geometry.
    await setNumberField(page, "רוחב (X)", 42);
    const after = await waitForModelChange(page, created);
    expect(after).toContain("42.0");
    assertSilent();
  });
}

test.describe("phone (390×844, touch)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  coreJourney();
});

test.describe("tablet (820×1180, touch)", () => {
  test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true });
  coreJourney();
});
