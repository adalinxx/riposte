// The deployed Pages site in Chromium, read only: the guestbook widget loads
// its thread from the live hosts, and the page logs no errors. Catches a
// broken Pages deploy.
//
//   node e2e/ui/live.mjs
import { chromium, expect as baseExpect } from "@playwright/test";

const SITE = "https://riposte.page/";
const expect = baseExpect.configure({ timeout: 120_000 });

const browser = await chromium.launch();
const errors = [];
try {
  const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(`page error: ${error.message}`));
  page.on("console", (message) => message.type() === "error" && errors.push(`console error: ${message.text()}`));
  await page.goto(SITE);
  const widget = page.locator("#riposte section.rp");
  // "Comments" until the thread is read, then its count.
  await expect(widget.locator("h2")).toHaveText(/^\d+ comments?$/);
  const heading = await widget.locator("h2").innerText();
  if (!heading.startsWith("0 ")) await expect(widget.locator("li.c").first()).toBeVisible();
  if (errors.length) throw new Error(`${SITE} logged errors:\n${errors.join("\n")}`);
  console.log(`${SITE} shows the guestbook: ${heading}, no errors`);
} finally {
  await browser.close();
}
