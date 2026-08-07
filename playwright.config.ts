/**
 * Playwright configuration for the UI regression suite.
 *
 * The 357 unit tests are entirely geometry: correct solids, correct repairs,
 * correct measurements. None of them would notice if a button stopped being
 * rendered, a panel threw, or an operation was wired to the wrong handler —
 * which is exactly the class of defect the expert review found. These tests
 * drive the real app in a real browser against the production build.
 *
 * Chromium only, on purpose: the app requires WebGL2 and a WASM kernel, and
 * running one browser well beats running three flakily.
 */

import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3210);

export default defineConfig({
  testDir: "./e2e",
  // Geometry operations genuinely take seconds; a tight timeout would make
  // the suite flaky rather than fast.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    // The pre-installed browser; never download one.
    launchOptions: { executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" },
    viewport: { width: 1500, height: 950 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
