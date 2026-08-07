/**
 * The hot path runs off the main thread (V6 item 5).
 *
 * The journey triggers a genuinely heavy rebuild (a long bold text string
 * booleaned over the base — dozens of glyph solids) and, WHILE the build
 * indicator is up, measures that the page still responds to input within a
 * tight bound. When the build ran on the main thread this exact interaction
 * stalled for the duration of the WASM booleans; a worker build leaves the
 * main thread free, so the bound is only meetable off-thread.
 *
 * The result itself is still asserted (dimensions change), so this cannot
 * pass by never finishing the build.
 */

import { expect, test } from "@playwright/test";
import { openEditor, readDimensions, waitForModelChange, watchForErrors } from "./helpers";

test.describe("worker build", () => {
  test("the UI stays responsive during a heavy rebuild", async ({ page }) => {
    const assertSilent = watchForErrors(page);
    await openEditor(page);

    // Select the nameplate's text layer and hand it a heavy string.
    await page.getByTitle("בחירת השכבה טקסט").click();
    const before = await readDimensions(page);
    const contentField = page.getByLabel("תוכן הטקסט");
    await contentField.fill("אבגדהוזחטיכלמנסעפצקרשת0123456789");

    // The build indicator must actually appear — otherwise the measurement
    // below would be measuring an idle page.
    const spinner = page.locator("text=בונה");
    await expect(spinner.first()).toBeVisible({ timeout: 15_000 });

    // While building: a pure-DOM interaction must complete promptly. With
    // the build on the main thread this fill() blocked until the booleans
    // finished; 1.5s is generous for a responsive page and far below the
    // multi-second build.
    const t0 = Date.now();
    await page.getByLabel("גודל טקסט").fill("21");
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1500);

    // And the heavy build must really complete with a changed model.
    await waitForModelChange(page, before);

    // Pin the execution path: in a real browser the build must have run in
    // the worker. A silent fallback to the main thread would still pass the
    // geometry assertions — this is the check that refuses it.
    await expect(page.getByTestId("viewport-dimensions")).toHaveAttribute(
      "data-build-ran-on",
      "worker"
    );
    assertSilent();
  });
});
