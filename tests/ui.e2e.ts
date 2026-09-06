// Optional browser smoke: supply PLAYWRIGHT_MODULE, CHROME_PATH, HOTSPARK_TEST_URL,
// TEST_PROJECT_ID and an administrator password on stdin. Use a disposable fixture project.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright-core"
);
const password = readFileSync(0, "utf8").trim(),
  project = process.env.TEST_PROJECT_ID;
if (!password || !project)
  throw new Error("Password on stdin and TEST_PROJECT_ID are required");
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.goto(process.env.HOTSPARK_TEST_URL ?? "http://127.0.0.1:3000");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
  await page.evaluate((id: string) => {
    location.hash = `projects/${id}`;
  }, project);
  await page
    .getByRole("heading", { name: "Active release", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "deployments", exact: true }).click();
  await page.locator("tbody tr").first().waitFor();
  const activeRow = page
    .locator("tbody tr")
    .filter({ hasText: "Active" })
    .first();
  await activeRow.getByRole("button").click();
  await page.getByRole("heading", { name: "Timeline", exact: true }).waitFor();
  await page.getByText("deployment active", { exact: false }).first().waitFor();
  await page
    .getByRole("button", { name: "Load build and migration logs" })
    .click();
  await page.waitForFunction(
    () => !!document.querySelector("pre")?.textContent?.trim(),
  );
  assert.ok(
    await page
      .getByRole("button", { name: "Roll back to these images" })
      .isEnabled(),
  );
  await page
    .getByRole("button", { name: "Enable maintenance", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Disable maintenance", exact: true })
    .waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent === "Disable maintenance" && !b.disabled,
    ),
  );
  await page
    .getByRole("button", { name: "Disable maintenance", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Enable maintenance", exact: true })
    .waitFor();
  await page.waitForFunction(
    () =>
      document.body.innerText.includes("Maintenance: disabled") &&
      [...document.querySelectorAll("button")].some(
        (b) => b.textContent === "Enable maintenance" && !b.disabled,
      ),
  );
  await page.getByRole("button", { name: "settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Refresh resource usage", exact: true })
    .click();
  await page.waitForFunction(() =>
    document.body.innerText.includes('"containers"'),
  );
  await page
    .getByRole("heading", { name: "Project backup", exact: true })
    .waitFor();
  await page.evaluate(() => {
    location.hash = "system";
  });
  await page.getByRole("heading", { name: "System", exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      document.body.innerText.includes("platform database") &&
      !document.body.innerText.includes("Installed API version: Loading"),
  );
  await page
    .getByRole("heading", { name: "Operational tasks", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Create platform backup", exact: true })
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "UI E2E passed: login, active release, deployment history/detail, timeline, logs, rollback availability, maintenance toggle, project resources and system diagnostics.",
  );
} finally {
  await browser.close();
}
