/**
 * Mesh import: OBJ through the summary dialog, 3MF straight into layers.
 *
 * Both parsers are covered by unit tests; what only a browser can show is
 * whether they are WIRED — whether one picker really accepts three formats
 * and whether a multi-object build really becomes multiple layers. Each
 * journey therefore ends on the geometry pipeline's own dimension readout.
 */

import { expect, test } from "@playwright/test";
import { makeZip } from "./zip";
import { openEditor, readDimensions, startBlank, watchForErrors } from "./helpers";

/** A 20×20×20 cube as OBJ text. */
const CUBE_OBJ = `# cube
v 0 0 0
v 20 0 0
v 20 20 0
v 0 20 0
v 0 0 20
v 20 0 20
v 20 20 20
v 0 20 20
f 1 4 3 2
f 5 6 7 8
f 1 2 6 5
f 2 3 7 6
f 3 4 8 7
f 4 1 5 8
`;

/** A 3MF build with two boxes, the second pushed 60 mm along X. */
function twoBoxThreeMf(): Buffer {
  const boxMesh = (sx: number, sy: number, sz: number) =>
    "<mesh><vertices>" +
    [
      [0, 0, 0],
      [sx, 0, 0],
      [sx, sy, 0],
      [0, sy, 0],
      [0, 0, sz],
      [sx, 0, sz],
      [sx, sy, sz],
      [0, sy, sz],
    ]
      .map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`)
      .join("") +
    "</vertices><triangles>" +
    [
      [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
      [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
      [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
    ]
      .map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`)
      .join("") +
    "</triangles></mesh>";

  const model =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
    "<resources>" +
    '<basematerials id="1"><base name="אדום" displaycolor="#CC2222FF"/></basematerials>' +
    `<object id="2" type="model" name="קובייה א" pid="1" pindex="0">${boxMesh(20, 20, 20)}</object>` +
    `<object id="3" type="model" name="קובייה ב">${boxMesh(10, 10, 10)}</object>` +
    "</resources><build>" +
    '<item objectid="2"/>' +
    '<item objectid="3" transform="1 0 0 0 1 0 0 0 1 60 0 0"/>' +
    "</build></model>";

  return makeZip([
    {
      name: "[Content_Types].xml",
      text:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
        "</Types>",
    },
    {
      name: "_rels/.rels",
      text:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
        "</Relationships>",
    },
    { name: "3D/3dmodel.model", text: model },
  ]);
}

/** "20.0 x 20.0 x 20.0 mm" → [20, 20, 20]. */
function dimensions(readout: string): number[] {
  return (readout.match(/[\d.]+/g) ?? []).map(Number);
}

test.describe("mesh import", () => {
  test("an OBJ becomes a solid through the summary dialog", async ({ page }) => {
    const assertSilent = watchForErrors(page);
    await openEditor(page);
    await startBlank(page);

    await page.getByLabel("קובץ מודל").setInputFiles({
      name: "cube.obj",
      mimeType: "text/plain",
      buffer: Buffer.from(CUBE_OBJ, "utf8"),
    });
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // The summary is computed from the parsed mesh, so it is already a
    // statement about geometry: 12 triangles, watertight.
    await expect(dialog).toContainText("12");
    await expect(dialog).toContainText("תקין");
    await dialog.getByRole("button", { name: "ייבא" }).click();

    await expect(page.getByTestId("viewport-dimensions")).toBeVisible({ timeout: 60_000 });
    const size = dimensions(await readDimensions(page));
    expect(size[0]).toBeCloseTo(20, 0);
    expect(size[1]).toBeCloseTo(20, 0);
    expect(size[2]).toBeCloseTo(20, 0);
    assertSilent();
  });

  test("a multi-object 3MF becomes one layer per body, placed by its build", async ({
    page,
  }) => {
    const assertSilent = watchForErrors(page);
    await openEditor(page);
    await startBlank(page);

    await page.getByLabel("קובץ מודל").setInputFiles({
      name: "two.3mf",
      mimeType: "model/3mf",
      buffer: twoBoxThreeMf(),
    });

    // No summary dialog: a build is not one mesh. It reports what it did.
    const notice = page.getByRole("dialog");
    await expect(notice).toContainText("2 גופים", { timeout: 60_000 });
    await notice.getByRole("button", { name: "הבנתי" }).click();

    await expect(page.getByTestId("viewport-dimensions")).toBeVisible({ timeout: 60_000 });
    // The 20 mm box at the origin and the 10 mm box at x=60 span 70 mm — the
    // build transform is in the geometry, not merely parsed and dropped.
    const size = dimensions(await readDimensions(page));
    expect(size[0]).toBeCloseTo(70, 0);
    expect(size[2]).toBeCloseTo(20, 0);

    // Both bodies are their own layer, named from the file.
    await expect(page.getByRole("button", { name: "קובייה א" })).toBeVisible();
    await expect(page.getByRole("button", { name: "קובייה ב" })).toBeVisible();
    assertSilent();
  });
});
