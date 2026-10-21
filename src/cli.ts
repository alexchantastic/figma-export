#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { ensureBrowser, chromiumInstalled } from "./browser-setup.js";
import path from "node:path";
import { AuthStore, browserLogin, browserAuthenticated } from "./auth.js";
import { login, type LoginOptions } from "./login.js";
import { RestFigmaApi } from "./api.js";
import { createFigmaSync, type SyncResult } from "./sync.js";
import { createProgressLogger } from "./progress.js";
import { concurrencyLimit } from "./concurrency.js";
import { parseDuration } from "./freshness.js";
import { listLocks, clearLock } from "./locks.js";
import { installShutdown } from "./shutdown.js";

function positiveNumber(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0)
    throw new Error("Expected a positive number.");
  return n;
}
async function secretPrompt(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Use --token-stdin or FIGMA_ACCESS_TOKEN in non-interactive environments.",
    );
  process.stderr.write("Figma personal access token (hidden): ");
  const input = process.stdin;
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stderr.write("\n");
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\u0003" || char === "\u0004") {
          cleanup();
          reject(new Error("Token entry cancelled."));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value.trim());
          return;
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    input.on("data", onData);
  });
}
async function installBrowser(): Promise<void> {
  const require = createRequire(import.meta.url);
  const cli = path.join(
    path.dirname(require.resolve("playwright/package.json")),
    "cli.js",
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "install", "chromium"], {
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("Browser installation failed.")),
    );
  });
}
const program = new Command();
program
  .name("figma-files-sync")
  .description("Synchronize native Figma Design files with local directories.")
  .version(
    JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ).version,
  )
  .option("--json", "Print machine-readable results")
  .option(
    "--recover-locks",
    "Recover only same-host locks whose process exited; never bypass live locks",
  )
  .option("--auth-dir <path>", "Override credential directory")
  .option("--headed", "Show the download browser")
  .option("--no-headless", "Show Chromium (alias for --headed)")
  .option(
    "--concurrency <tabs>",
    "Active download tabs in one Chromium (1–3; default 1)",
    (value) => concurrencyLimit(Number(value)),
    1,
  )
  .option(
    "--api-concurrency <requests>",
    "Concurrent API operations, independent from download tabs (1–3; default 1)",
    (value) => concurrencyLimit(Number(value)),
    1,
  )
  .option(
    "--ignore <duration>",
    "Reuse successful API checks newer than this duration, not downloads (e.g. 1m, 30m, 4h)",
    (value) => {
      parseDuration(value);
      return value;
    },
  )
  .option(
    "--timeout <seconds>",
    "Editor/download timeout",
    positiveNumber,
    180,
  );
function auth(): AuthStore {
  return new AuthStore(program.opts().authDir);
}
function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
async function execute(
  action: (client: ReturnType<typeof createFigmaSync>) => Promise<SyncResult>,
): Promise<void> {
  const opts = program.opts();
  const progress = createProgressLogger((line) => console.error(line));
  const started = Date.now();
  const controller = new AbortController();
  const removeShutdown = installShutdown(controller, (message) =>
    console.error(message),
  );
  progress.report({
    phase: "manifest",
    message: "Starting operation in " + process.cwd(),
  });
  const client = createFigmaSync({
    authDirectory: opts.authDir,
    headed: opts.headed || opts.headless === false,
    concurrency: opts.concurrency,
    apiConcurrency: opts.apiConcurrency,
    ignore: opts.ignore,
    recoverLocks: opts.recoverLocks,
    signal: controller.signal,
    onProgress: progress.report,
    onEvent: opts.json
      ? undefined
      : (item) =>
          progress.report({
            phase: "file",
            message:
              item.status.toUpperCase() +
              ": " +
              path.join(item.directory, item.localPath) +
              (item.message ? " — " + item.message : ""),
          }),
    timeoutMs: opts.timeout * 1000,
  });
  try {
    const result = await action(client);
    if (opts.json) print(result);
    else {
      console.log(
        "Finished in " +
          ((Date.now() - started) / 1000).toFixed(1) +
          "s: " +
          result.items.length +
          " files processed, " +
          result.items.filter((item) => item.status === "downloaded").length +
          " downloaded, " +
          result.errors.length +
          " errors.",
      );
      for (const error of result.errors) console.error(error);
      if (!result.items.length && !result.errors.length)
        console.log("No managed files. Use figma-files-sync add <url>.");
    }
    if (
      result.errors.length ||
      result.items.some((item) =>
        ["conflict", "unavailable", "unsupported", "error"].includes(
          item.status,
        ),
      )
    )
      process.exitCode = 1;
  } finally {
    progress.report({
      phase: "browser",
      message: "Closing download browser / releasing resources",
    });
    try {
      await client.close();
    } finally {
      progress.stop();
      removeShutdown();
    }
  }
}
program
  .command("add <url> [directory]")
  .description("Register a Design file or folder and download pending files")
  .option("--force", "Back up and replace locally modified managed files")
  .action(
    async (
      url: string,
      directory: string | undefined,
      opts: { force?: boolean },
    ) => execute((client) => client.add(url, { directory, force: opts.force })),
  );
for (const command of ["fetch", "sync"] as const) {
  program
    .command(command)
    .description(
      command === "fetch"
        ? "Check remote changes without downloading .fig files"
        : "Check changes and download only new, changed or missing files",
    )
    .option("--no-recursive", "Process only the current directory")
    .option("--force", "Back up and replace local conflicts during sync")
    .action(async (opts: { recursive: boolean; force?: boolean }) =>
      execute((client) => client[command](opts)),
    );
}
program
  .command("login")
  .description(
    "Check token and browser authentication; configure only missing or expired credentials",
  )
  .option("--only-token", "Check/configure only the API token")
  .option("--only-browser", "Check/configure only the browser session")
  .option(
    "--force",
    "Explicitly replace the selected credentials instead of reusing them",
  )
  .option(
    "--token-stdin",
    "Read a replacement token from stdin (use --only-token for token setup alone)",
  )
  .option(
    "--install-browser",
    "Install missing Chromium without asking for confirmation",
  )
  .action(async (opts: LoginOptions & { installBrowser?: boolean }) => {
    if (program.opts().json)
      throw new Error(
        "Interactive login does not support --json; use auth status for JSON output.",
      );
    const store = auth();
    let browserReady = false;
    const prepareBrowser = async () => {
      if (browserReady) return;
      await ensureBrowser(
        {
          installed: chromiumInstalled,
          interactive: !!process.stdin.isTTY && !!process.stdout.isTTY,
          install: installBrowser,
          confirm: async () => {
            const prompt = createInterface({
              input: process.stdin,
              output: process.stdout,
            });
            try {
              return /^(y|yes|s|sim)$/i.test(
                (
                  await prompt.question(
                    "Chromium is required for Figma login/downloads. Download and install it now? [y/N] ",
                  )
                ).trim(),
              );
            } finally {
              prompt.close();
            }
          },
        },
        opts.installBrowser,
      );
      browserReady = true;
    };
    await login(opts, {
      savedToken: () => store.token(),
      validateToken: (token) => new RestFigmaApi(token).validateToken(),
      requestToken: async () => {
        if (opts.tokenStdin) {
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin)
            chunks.push(Buffer.from(chunk));
          return Buffer.concat(chunks).toString("utf8").trim();
        }
        if (process.env.FIGMA_ACCESS_TOKEN && !opts.force)
          throw new Error(
            "FIGMA_ACCESS_TOKEN is invalid or expired. Update/unset it, or supply a replacement with --token-stdin (the environment override must also be updated).",
          );
        console.log(
          "Create a personal access token in Figma Settings → Security with file_metadata:read, folders:read and current_user:read. Never share your token.",
        );
        if (process.env.FIGMA_ACCESS_TOKEN)
          console.log(
            "FIGMA_ACCESS_TOKEN overrides saved credentials; update/unset it after replacing your token.",
          );
        return secretPrompt();
      },
      saveToken: (token) => store.saveToken(token),
      browserAuthenticated: async () => {
        if (!(await store.hasSession()) && !process.env.FIGMA_AUTH_COOKIE)
          return false;
        await prepareBrowser();
        return browserAuthenticated(store);
      },
      loginBrowser: async (force) => {
        if (!process.stdin.isTTY)
          throw new Error(
            "Browser login requires an interactive terminal. Use --only-token for token setup alone.",
          );
        await prepareBrowser();
        console.log(
          "Sign in to Figma in the isolated browser, including SSO/2FA if required.",
        );
        if (force && process.env.FIGMA_AUTH_COOKIE)
          console.log(
            "FIGMA_AUTH_COOKIE overrides saved sessions; update/unset it after replacing the browser login.",
          );
        await browserLogin(store, { force });
      },
      report: (message) => console.log(message),
    });
  });
program
  .command("install-browser")
  .description("Explicitly install Chromium for native downloads")
  .action(installBrowser);
program
  .command("logout")
  .description(
    "Remove saved token and session (environment overrides remain active)",
  )
  .action(async () => {
    await auth().logout();
    if (program.opts().json) print({ loggedOut: true });
    else
      console.log(
        "Saved credentials removed. Environment variables are unchanged.",
      );
  });
const locks = program
  .command("locks")
  .description("Inspect/recover locks without changing manifests");
locks
  .command("list [directory]")
  .description("List locks recursively with PID, host and liveness")
  .option("--no-recursive", "Inspect only this directory")
  .action(
    async (directory: string | undefined, opts: { recursive: boolean }) => {
      const found = await listLocks(
        path.resolve(directory ?? "."),
        opts.recursive,
      );
      if (program.opts().json) print(found);
      else if (!found.length) console.log("No locks found.");
      else
        for (const lock of found)
          console.log(
            lock.state.toUpperCase() +
              " " +
              lock.path +
              " — PID " +
              (lock.pid ?? "?") +
              ", host " +
              (lock.host ?? "unknown") +
              ": " +
              lock.reason,
          );
    },
  );
locks
  .command("clear [directory]")
  .description("Remove a proven stale lock in exactly one directory")
  .option(
    "--force",
    "Remove unknown/legacy/foreign-host lock after checking its owner manually; active local PIDs remain blocked",
  )
  .action(async (directory: string | undefined, opts: { force?: boolean }) => {
    const removed = await clearLock(
      path.resolve(directory ?? "."),
      !!opts.force,
    );
    if (program.opts().json) print({ removed });
    else
      console.log(
        removed
          ? "Lock removed. No manifests or native files were changed."
          : "No lock present.",
      );
  });
const authCommand = program
  .command("auth")
  .description("Inspect authentication configuration");
authCommand
  .command("status")
  .description(
    "Show configured credentials without exposing secrets or network requests",
  )
  .action(async () => {
    const store = auth();
    const result = {
      tokenConfigured: !!(await store.token()),
      browserSessionSaved: await store.hasSession(),
      cookieOverride: !!process.env.FIGMA_AUTH_COOKIE,
      validity: "not-checked",
    };
    if (program.opts().json) print(result);
    else
      console.log(
        "Token: " +
          (result.tokenConfigured ? "configured" : "missing") +
          "\nBrowser session: " +
          (result.browserSessionSaved ? "saved" : "missing") +
          "\nValidity: checked when used",
      );
  });
try {
  await program.parseAsync();
} catch (error) {
  const message = error instanceof Error ? error.message : "Command failed.";
  if (program.opts().json) print({ error: message });
  else console.error("Error: " + message);
  process.exitCode ||= 1;
}
