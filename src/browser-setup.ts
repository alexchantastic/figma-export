import { chromium } from "playwright";

export interface BrowserSetupSteps {
  installed(): Promise<boolean>;
  confirm(): Promise<boolean>;
  install(): Promise<void>;
  interactive: boolean;
}
/** Only missing executables trigger installation; OS/network errors must not cause reinstall loops. */
export async function chromiumInstalled(): Promise<boolean> {
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      /Executable doesn't exist/i.test(error.message)
    )
      return false;
    throw new Error(
      "Could not start Chromium. Check OS dependencies and permissions; try figma-files-sync install-browser for missing browser files.",
    );
  }
}
export async function ensureBrowser(
  steps: BrowserSetupSteps,
  installRequested = false,
): Promise<void> {
  if (await steps.installed()) return;
  if (!installRequested) {
    if (!steps.interactive)
      throw new Error(
        "Chromium is missing. Run figma-files-sync install-browser or login --install-browser from an interactive terminal.",
      );
    if (!(await steps.confirm()))
      throw new Error(
        "Chromium installation declined. Run figma-files-sync install-browser when ready.",
      );
  }
  await steps.install();
  if (!(await steps.installed()))
    throw new Error(
      "Chromium is still unavailable after installation. Check Playwright installation and OS dependencies.",
    );
}
