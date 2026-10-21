import { ResourcePool, serialQueue, concurrencyLimit } from "./concurrency.js";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { open } from "node:fs/promises";
import { setTimeout as waitDelay } from "node:timers/promises";
import { AuthStore, addAuthCookie } from "./auth.js";
import type { ProgressReporter } from "./progress.js";
import { navigateToFile } from "./navigation.js";

export interface NativeDownloader {
  download(key: string, destination: string): Promise<void>;
  close(): Promise<void>;
}
export interface DownloadOptions {
  headed?: boolean;
  signal?: AbortSignal;
  /** Maximum active editor tabs (1–3). */
  concurrency?: number;
  timeoutMs?: number;
  delayMs?: number;
  onProgress?: ProgressReporter;
}
/** UI adapter extracted from the original exporter. Keep Figma-specific selectors here. */
export class PlaywrightDownloader implements NativeDownloader {
  private browser?: Browser;
  private context?: BrowserContext;
  private nextStart = 0;
  private initializing?: Promise<BrowserContext>;
  private tabs?: ResourcePool<Page>;
  private readonly starts = serialQueue();
  private readonly sessionWrites = serialQueue();
  constructor(
    private readonly auth: AuthStore,
    private readonly options: DownloadOptions = {},
    private readonly browserType: Pick<typeof chromium, "launch"> = chromium,
  ) {
    concurrencyLimit(options.concurrency);
  }
  private ready(): Promise<BrowserContext> {
    return (this.initializing ??= this.initialize().catch(async (error) => {
      await this.browser?.close().catch(() => {});
      this.browser = undefined;
      this.context = undefined;
      this.tabs = undefined;
      this.initializing = undefined;
      throw error;
    }));
  }
  private async initialize(): Promise<BrowserContext> {
    if (this.context) return this.context;
    this.options.onProgress?.({
      phase: "auth",
      message: "Loading saved Figma browser authentication",
    });
    if (!(await this.auth.hasSession()) && !process.env.FIGMA_AUTH_COOKIE)
      throw new Error("Browser login required. Run figma-files-sync login.");
    this.options.onProgress?.({
      phase: "browser",
      message:
        "Opening Chromium (" +
        (this.options.headed ? "visible" : "headless") +
        ")",
    });
    this.browser = await this.browserType.launch({
      headless: !this.options.headed,
    });
    this.context = await this.browser.newContext({
      locale: "en-US",
      acceptDownloads: true,
      ...((await this.auth.hasSession())
        ? { storageState: this.auth.sessionPath }
        : {}),
    });
    if (process.env.FIGMA_AUTH_COOKIE)
      await addAuthCookie(this.context, process.env.FIGMA_AUTH_COOKIE);
    const context = this.context;
    this.tabs = new ResourcePool(
      () => context.newPage(),
      (page) => page.close(),
      concurrencyLimit(this.options.concurrency),
    );
    await this.tabs.use(async () => {});
    return context;
  }
  async download(key: string, destination: string): Promise<void> {
    const context = await this.ready();
    this.options.signal?.throwIfAborted();
    await this.tabs!.use(async (page) => {
      this.options.signal?.throwIfAborted();
      const abort = () => {
        void page.close().catch(() => {});
      };
      this.options.signal?.addEventListener("abort", abort, { once: true });
      try {
        this.options.signal?.throwIfAborted();
        this.options.onProgress?.({
          phase: "browser",
          message: "Using shared Chromium tab for " + key,
        });
        await this.starts(async () => {
          const delay = this.nextStart - Date.now();
          if (delay > 0) {
            this.options.onProgress?.({
              phase: "download",
              message:
                "Waiting " +
                Math.ceil(delay / 1000) +
                "s before opening editor for " +
                key,
            });
            await waitDelay(delay, undefined, { signal: this.options.signal });
          }
          this.nextStart =
            Date.now() + Math.max(10_000, this.options.delayMs ?? 10_000);
        });
        const timeout = this.options.timeoutMs ?? 180_000;
        page.setDefaultTimeout(timeout);
        try {
          this.options.onProgress?.({
            phase: "browser",
            message:
              "Opening Figma editor for " +
              key +
              " (timeout " +
              Math.round(timeout / 1000) +
              "s)",
          });
          await navigateToFile(page, key, timeout, this.options.onProgress);
          if (/\/(login|signup)(?:\/|$)/.test(new URL(page.url()).pathname))
            throw new Error(
              "Browser session expired. Run figma-files-sync login.",
            );
          await page
            .getByRole("button", { name: "Close", exact: true })
            .click({ timeout: 2000 })
            .catch(() => {});
          this.options.onProgress?.({
            phase: "browser",
            message: "Waiting for editor / opening File menu for " + key,
          });
          await page.locator("[data-tooltip='main-menu']").click();
          await page.locator("[aria-controls^='mainMenu.file-menu']").click();
          const action = page.getByText("Save local copy…", { exact: true });
          this.options.onProgress?.({
            phase: "download",
            message:
              "Requesting Save local copy; waiting for Figma to generate " +
              key +
              ".fig",
          });
          const [download] = await Promise.all([
            page.waitForEvent("download", { timeout }),
            action.click(),
          ]);
          if (!download.suggestedFilename().toLowerCase().endsWith(".fig"))
            throw new Error(
              "Figma returned a non-.fig document; only Figma Design is supported.",
            );
          this.options.onProgress?.({
            phase: "download",
            message:
              "Download started for " +
              key +
              "; waiting for transfer to finish",
          });
          await download.saveAs(destination);
          if (await download.failure())
            throw new Error("Figma native download failed.");
          this.options.onProgress?.({
            phase: "download",
            message: "Transfer finished; validating native file for " + key,
          });
          await verifyNativeFile(destination);
          await this.sessionWrites(() => this.auth.saveSession(context));
          this.options.signal?.throwIfAborted();
          // Preserve the Figma app in this tab between files instead of unloading it.
        } catch (error) {
          if (error instanceof Error && error.name === "TimeoutError")
            throw new Error(
              "Figma UI/download timed out. Check session, export permissions, desktop-app link settings, or retry with --headed / --timeout. No export restrictions are bypassed.",
            );
          throw error;
        }
      } finally {
        this.options.signal?.removeEventListener("abort", abort);
      }
    });
  }
  async close(): Promise<void> {
    try {
      await this.tabs?.close();
    } finally {
      await this.browser?.close();
      this.tabs = undefined;
      this.browser = undefined;
      this.context = undefined;
      this.initializing = undefined;
      this.nextStart = 0;
    }
  }
}
export async function verifyNativeFile(file: string): Promise<void> {
  const handle = await open(file, "r");
  try {
    const stat = await handle.stat();
    const head = Buffer.alloc(512);
    const { bytesRead } = await handle.read(head, 0, 512, 0);
    const text = head.subarray(0, bytesRead).toString("utf8").trimStart();
    if (
      !stat.isFile() ||
      stat.size === 0 ||
      text.startsWith("<") ||
      text.startsWith("{") ||
      text.startsWith("[")
    )
      throw new Error(
        "Download is empty or contains an error response, not a native .fig file.",
      );
    // Proprietary container signatures may evolve. Sanity checks are not full format validation.
  } finally {
    await handle.close();
  }
}
