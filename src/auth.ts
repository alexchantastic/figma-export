import os from "node:os";
import path from "node:path";
import { readFile, unlink, chmod } from "node:fs/promises";
import { chromium, type BrowserContext } from "playwright";
import {
  atomicWrite,
  ensureDirectory,
  assertRegular,
  isNotFound,
} from "./manifest.js";
import { z } from "zod";

const configSchema = z.object({ token: z.string().optional() });
export function defaultAuthDirectory(): string {
  if (process.platform === "win32")
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "figma-files-sync",
    );
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "figma-files-sync",
  );
}
export class AuthStore {
  readonly directory: string;
  constructor(directory = defaultAuthDirectory()) {
    this.directory = path.resolve(directory);
  }
  get sessionPath(): string {
    return path.join(this.directory, "session.json");
  }
  async token(): Promise<string | undefined> {
    if (process.env.FIGMA_ACCESS_TOKEN) return process.env.FIGMA_ACCESS_TOKEN;
    const file = path.join(this.directory, "config.json");
    if (!(await assertRegular(file))) return undefined;
    return configSchema.parse(JSON.parse(await readFile(file, "utf8"))).token;
  }
  private async prepare(): Promise<void> {
    await ensureDirectory(this.directory);
    await chmod(this.directory, 0o700);
  }
  async saveToken(token: string): Promise<void> {
    await this.prepare();
    await atomicWrite(
      path.join(this.directory, "config.json"),
      JSON.stringify({ token }, null, 2) + "\n",
    );
  }
  async hasSession(): Promise<boolean> {
    return assertRegular(this.sessionPath);
  }
  async saveSession(context: BrowserContext): Promise<void> {
    await this.prepare();
    await atomicWrite(
      this.sessionPath,
      JSON.stringify(await context.storageState()),
    );
  }
  async logout(): Promise<void> {
    for (const name of ["config.json", "session.json"]) {
      const file = path.join(this.directory, name);
      if (await assertRegular(file))
        await unlink(file).catch((e) => {
          if (!isNotFound(e)) throw e;
        });
    }
  }
}
export async function addAuthCookie(
  context: BrowserContext,
  value: string,
): Promise<void> {
  await context.addCookies([
    {
      name: "__Host-figma.authn",
      value,
      domain: "www.figma.com",
      path: "/",
      httpOnly: true,
      secure: true,
    },
  ]);
}
/** Probe the existing session without showing a login window. Network/UI failures are not proof of expiry. */
export async function browserAuthenticated(store: AuthStore): Promise<boolean> {
  if (!(await store.hasSession()) && !process.env.FIGMA_AUTH_COOKIE)
    return false;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      locale: "en-US",
      ...((await store.hasSession())
        ? { storageState: store.sessionPath }
        : {}),
    });
    if (process.env.FIGMA_AUTH_COOKIE)
      await addAuthCookie(context, process.env.FIGMA_AUTH_COOKIE);
    const page = await context.newPage();
    await page.goto("https://www.figma.com/files", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    const authenticated = await Promise.race([
      page
        .getByTestId("ProfileButton")
        .waitFor({ state: "attached", timeout: 30_000 })
        .then(() => true),
      page
        .waitForURL((url) => /\/(login|signup)(?:\/|$)/.test(url.pathname), {
          timeout: 30_000,
        })
        .then(() => false),
    ]);
    if (authenticated) await store.saveSession(context);
    return authenticated;
  } catch {
    throw new Error(
      "Could not verify the saved browser session. Check connectivity / Chromium installation and retry. Use --force --only-browser to explicitly sign in again.",
    );
  } finally {
    await browser.close();
  }
}
export async function browserLogin(
  store: AuthStore,
  options: { force?: boolean } = {},
): Promise<void> {
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext({
      locale: "en-US",
      ...(!options.force && (await store.hasSession())
        ? { storageState: store.sessionPath }
        : {}),
    });
    if (!options.force && process.env.FIGMA_AUTH_COOKIE)
      await addAuthCookie(context, process.env.FIGMA_AUTH_COOKIE);
    const page = await context.newPage();
    await page.goto("https://www.figma.com/files", {
      waitUntil: "domcontentloaded",
    });
    await page
      .getByTestId("ProfileButton")
      .waitFor({ state: "attached", timeout: 300_000 });
    await store.saveSession(context);
  } finally {
    await browser.close();
  }
}
