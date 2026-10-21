import type { Page } from "playwright";
import type { ProgressReporter } from "./progress.js";

/** Prefer links exposed by Figma itself. Never fabricate router state or address-bar-only changes. */
export async function navigateToFile(
  page: Page,
  key: string,
  timeout: number,
  report?: ProgressReporter,
): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new Error("Invalid Figma file key.");
  const target = "https://www.figma.com/design/" + key;
  const current = new URL(page.url());
  if (current.origin === "https://www.figma.com") {
    const selectors: string[] = [];
    for (const type of ["design", "file"])
      for (const prefix of ["/", "https://www.figma.com/"]) {
        const href = prefix + type + "/" + key;
        for (const suffix of ["", "/", "?"]) {
          const operator = suffix ? "^=" : "=";
          selectors.push(
            "a[href" +
              operator +
              '"' +
              href +
              suffix +
              '"]:visible:not([target="_blank"]):not([download])',
          );
        }
      }
    const link = page.locator(selectors.join(",")).first();
    if (await link.count()) {
      report?.({
        phase: "browser",
        message:
          "Following Figma's existing in-app link in the same tab for " + key,
      });
      try {
        await link.click({ timeout: Math.min(timeout, 10_000) });
        await page.waitForURL(
          (url) =>
            url.origin === "https://www.figma.com" &&
            new RegExp("^/(?:design|file)/" + key + "(?:/|$)").test(
              url.pathname,
            ),
          { timeout: Math.min(timeout, 15_000) },
        );
        return;
      } catch {
        report?.({
          phase: "browser",
          message:
            "In-app link did not complete; falling back to document navigation for " +
            key,
        });
      }
    }
  }
  report?.({
    phase: "browser",
    message:
      "Navigating shared tab to " +
      key +
      " (full document navigation; no usable in-app link)",
  });
  await page.goto(target, { waitUntil: "domcontentloaded", timeout });
}
