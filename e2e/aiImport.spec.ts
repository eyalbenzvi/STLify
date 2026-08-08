/**
 * AI image-import journeys, mocked at the boundaries the plan names:
 *
 * - Smart relief: the ONNX runner is replaced by the deterministic test-mode
 *   fakes (localStorage flag; lib/ai/testMode.ts) — everything downstream
 *   (grids, mesher, kernel, document) is real, and the assertion is about
 *   the built solid's dimensions, not the DOM.
 * - Cloud model: the /api/image-to-3d proxy is stubbed with page.route so
 *   the real client, consent gate, repair funnel and document pipeline run
 *   against a scripted provider. The assertion is again geometry: the layer
 *   exists with the expected scaled bounds.
 */

import { expect, test, type Page } from "@playwright/test";
import { encodePng, fillRect } from "./png";
import { openEditor, readDimensions, setNumberField, startBlank, watchForErrors } from "./helpers";

const SIZE = 200;

function anyArtwork(): Buffer {
  const rgb = new Uint8Array(SIZE * SIZE * 3).fill(240);
  fillRect(rgb, SIZE, { x0: 60, y0: 60, x1: 140, y1: 140 }, [40, 40, 60]);
  return encodePng(SIZE, SIZE, rgb);
}

async function uploadImage(page: Page): Promise<void> {
  await page.getByLabel("קובץ תמונה").setInputFiles({
    name: "photo.png",
    mimeType: "image/png",
    buffer: anyArtwork(),
  });
  await expect(page.getByRole("dialog")).toBeVisible();
}

/** "50.0 x 50.0 x 2.9 mm" → [50, 50, 2.9]. */
function dims(readout: string): number[] {
  return readout.match(/[\d.]+/g)?.map(Number) ?? [];
}

test.describe("AI image import", () => {
  test("smart relief builds a solid with the expected footprint and height", async ({
    page,
  }) => {
    const assertSilent = watchForErrors(page);
    // The e2e mock boundary for on-device inference (see lib/ai/testMode.ts):
    // fake depth = radial gradient, fake mask = centred disk.
    await page.addInitScript(() => localStorage.setItem("stlify.aiTestMode", "1"));
    await openEditor(page);
    await startBlank(page);

    await uploadImage(page);
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("radio", { name: "תבליט חכם (AI)" }).click();
    // The confirm is gated until the depth map exists.
    await expect(dialog.getByRole("button", { name: "צור גוף" })).toBeDisabled();
    await dialog.getByRole("button", { name: "חשב מפת עומק (AI)" }).click();
    await expect(dialog.getByTestId("depth-preview-canvas")).toBeVisible({ timeout: 20_000 });

    await setNumberField(page, "רוחב יעד", 50);
    await dialog.getByRole("button", { name: "צור גוף" }).click();

    await expect(page.getByTestId("viewport-dimensions")).toBeVisible({ timeout: 60_000 });
    const [x, y, z] = dims(await readDimensions(page));
    // Geometry consequence: a 50mm square plate whose peak reaches the base
    // thickness (1mm) plus almost the full relief height (2mm).
    expect(x).toBeGreaterThan(49);
    expect(x).toBeLessThan(51);
    expect(y).toBeGreaterThan(49);
    expect(y).toBeLessThan(51);
    expect(z).toBeGreaterThan(2.4);
    expect(z).toBeLessThanOrEqual(3.05);
    assertSilent();
  });

  test("cloud model asks consent, then imports the provider mesh at target size", async ({
    page,
  }) => {
    const assertSilent = watchForErrors(page);
    const TASK = "123e4567-e89b-12d3-a456-426614174000";
    // A 20 x 30 x 10 box; the importer scales its 30-unit footprint to 80mm.
    const obj = [
      "v 0 0 0", "v 20 0 0", "v 20 30 0", "v 0 30 0",
      "v 0 0 10", "v 20 0 10", "v 20 30 10", "v 0 30 10",
      "f 1 3 2", "f 1 4 3",
      "f 5 6 7", "f 5 7 8",
      "f 1 2 6", "f 1 6 5",
      "f 2 3 7", "f 2 7 6",
      "f 3 4 8", "f 3 8 7",
      "f 4 1 5", "f 4 5 8",
    ].join("\n");

    let uploaded = false;
    await page.route("**/api/image-to-3d**", async (route) => {
      const url = new URL(route.request().url());
      const method = route.request().method();
      const json = (body: unknown) =>
        route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
      if (url.pathname === "/api/image-to-3d" && method === "GET") {
        return json({ enabled: true, providerNameHe: "Meshy" });
      }
      if (url.pathname === "/api/image-to-3d" && method === "POST") {
        uploaded = true;
        return json({ taskId: TASK });
      }
      if (url.pathname === `/api/image-to-3d/${TASK}` && method === "GET") {
        return json({ state: "succeeded" });
      }
      if (url.pathname === `/api/image-to-3d/${TASK}/model` && method === "GET") {
        return route.fulfill({ contentType: "application/octet-stream", body: obj });
      }
      return route.fulfill({ status: 404, body: "{}" });
    });

    await openEditor(page);
    await startBlank(page);
    await uploadImage(page);

    const dialog = page.getByRole("dialog");
    await dialog.getByRole("radio", { name: "מודל מלא (AI, ענן)" }).click();
    await setNumberField(page, "גודל יעד", 80);
    await dialog.getByRole("button", { name: "צור מודל בענן" }).click();

    // The consent gate names the provider, and NOTHING has been uploaded yet.
    const consent = page.getByRole("dialog", { name: "שליחת התמונה לשירות ענן" });
    await expect(consent).toBeVisible();
    await expect(consent).toContainText("Meshy");
    expect(uploaded).toBe(false);
    await consent.getByRole("button", { name: "אני מאשר/ת לשלוח" }).click();

    // Upload → poll (first poll after ~4s) → download → repair → layer.
    await expect(page.getByTestId("viewport-dimensions")).toBeVisible({ timeout: 90_000 });
    expect(uploaded).toBe(true);
    const sorted = dims(await readDimensions(page)).sort((a, b) => a - b);
    // 20x30x10 scaled by 80/30 → 53.3 x 80 x 26.7.
    expect(sorted[2]).toBeGreaterThan(79);
    expect(sorted[2]).toBeLessThan(81);
    expect(sorted[1]).toBeGreaterThan(52);
    expect(sorted[1]).toBeLessThan(55);
    expect(sorted[0]).toBeGreaterThan(25.5);
    expect(sorted[0]).toBeLessThan(28);
    assertSilent();
  });
});
