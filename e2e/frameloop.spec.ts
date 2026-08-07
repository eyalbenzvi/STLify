/**
 * Demand-frameloop regression journey (V6 item 2).
 *
 * The canvas renders with `frameloop="demand"`, so a missed `invalidate()`
 * is a FROZEN viewport — the most dangerous possible regression of that
 * change, because nothing errors. This journey walks every tool mode and a
 * set of imperative change points, asserting after each one that the pixels
 * inside the viewport actually changed.
 */

import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  addFirstPrimitive,
  addPrimitive,
  clickViewportCenter,
  openEditor,
  setNumberField,
  startBlank,
  waitForModelChange,
  watchForErrors,
} from "./helpers";

/** Hash of the viewport's current pixels (element screenshot). */
async function viewportHash(page: Page): Promise<string> {
  const canvas = page.locator("canvas").first();
  const shot = await canvas.screenshot({ animations: "disabled" });
  return createHash("sha1").update(shot).digest("hex");
}

/** Assert the viewport repaints (pixels differ from `before`). */
async function expectRepaint(page: Page, before: string, label: string): Promise<string> {
  await expect
    .poll(async () => viewportHash(page), {
      timeout: 30_000,
      intervals: [250, 500],
      message: `viewport must repaint after: ${label}`,
    })
    .not.toBe(before);
  return viewportHash(page);
}

test.describe("demand frameloop", () => {
  test("the viewport repaints in every tool mode and change point", async ({ page }) => {
    const assertSilent = watchForErrors(page);
    await openEditor(page);
    await startBlank(page);
    await addFirstPrimitive(page, "תיבה");
    let last = await viewportHash(page);

    // -- numeric translate: the pose is applied imperatively (no rebuild).
    await setNumberField(page, "X", 40);
    last = await expectRepaint(page, last, "numeric translate");

    // -- select: moving the selection to another body moves the highlight.
    //    (Creation auto-selects, so a same-body click would be a no-change
    //    no-op — the selection CHANGE is what must repaint.)
    await addPrimitive(page, "גליל");
    last = await viewportHash(page);
    await page.getByTitle("בחירת השכבה תיבה").click();
    last = await expectRepaint(page, last, "selection change");

    // -- translate / rotate / scale: each gizmo draws over the selection.
    //    (Scoped to the toolbar — the history panel lists steps by the same
    //    Hebrew names.)
    const toolbar = page.getByRole("toolbar", { name: "כלי טרנספורמציה" });
    await toolbar.getByRole("button", { name: "הזזה", exact: true }).click();
    last = await expectRepaint(page, last, "translate gizmo");
    await toolbar.getByRole("button", { name: "סיבוב", exact: true }).click();
    last = await expectRepaint(page, last, "rotate gizmo");
    await toolbar.getByRole("button", { name: "קנה מידה", exact: true }).click();
    last = await expectRepaint(page, last, "scale gizmo");
    await toolbar.getByRole("button", { name: "בחירה", exact: true }).click();
    last = await expectRepaint(page, last, "back to select");

    // -- orbit: a camera drag is entirely outside React.
    const canvas = page.locator("canvas").first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error("canvas has no bounding box");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 90, cy + 45, { steps: 6 });
    await page.mouse.up();
    last = await expectRepaint(page, last, "orbit drag");

    // -- measure: banner, then a pending point, then the finished line.
    await page.getByRole("button", { name: "מדידה (שתי נקודות)" }).click();
    last = await expectRepaint(page, last, "measure mode banner");
    await page.mouse.click(cx - 20, cy - 10);
    last = await expectRepaint(page, last, "measure first point");
    await page.mouse.click(cx + 25, cy + 10);
    last = await expectRepaint(page, last, "measure second point");
    await page.getByRole("button", { name: "מדידה (שתי נקודות)" }).click();

    // -- face selection: the picked region is drawn as an orange overlay.
    await page.getByRole("button", { name: "הפעל בחירת פאות" }).click();
    await clickViewportCenter(page);
    last = await expectRepaint(page, last, "face-select highlight");
    await page.getByRole("button", { name: /מצב בחירת פאות פעיל/ }).click();
    last = await expectRepaint(page, last, "face-select off");

    // -- placeOnSurface / drainHole: entering the mode shows the viewport
    //    banner and the pick cursor. (Their pick action is covered by their
    //    own journeys; here the claim is that the mode change repaints.)
    await page.getByTitle("בחירת השכבה תיבה").click();
    await page.getByRole("button", { name: "הנח על משטח", exact: true }).click();
    last = await expectRepaint(page, last, "placeOnSurface mode");
    await page.keyboard.press("Escape");
    last = await expectRepaint(page, last, "placeOnSurface off");
    await page.getByRole("button", { name: "חור ניקוז", exact: true }).click();
    last = await expectRepaint(page, last, "drainHole mode");
    await page.keyboard.press("Escape");
    last = await expectRepaint(page, last, "drainHole off");

    // -- x-ray, section, print preview: material/clipping mutations.
    await page.getByLabel("מצב שקוף").check();
    last = await expectRepaint(page, last, "x-ray on");
    await page.getByLabel("מצב שקוף").uncheck();
    last = await expectRepaint(page, last, "x-ray off");
    await page.getByLabel("הפעלת מבט חתך").check();
    last = await expectRepaint(page, last, "section on");
    await page.getByLabel("הפעלת מבט חתך").uncheck();
    last = await expectRepaint(page, last, "section off");
    await page.getByLabel("תצוגת הדפסה מקדימה").check();
    last = await expectRepaint(page, last, "print preview on");
    await page.getByLabel("תצוגת הדפסה מקדימה").uncheck();
    last = await expectRepaint(page, last, "print preview off");

    // -- a real geometry rebuild: resize, then undo from the keyboard.
    await page.getByTitle("בחירת השכבה תיבה").click();
    const dims = await page.getByTestId("viewport-dimensions").innerText();
    await setNumberField(page, "רוחב (X)", 42);
    const resized = await waitForModelChange(page, dims.trim());
    last = await expectRepaint(page, last, "rebuild after resize");
    await page.keyboard.press("Control+z");
    await waitForModelChange(page, resized);
    await expectRepaint(page, last, "undo rebuild");

    assertSilent();
  });
});
