import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";
import fs from "node:fs";

dotenv.config();

// Check if there are any files to download
let hasFilesToDownload = false;
if (fs.existsSync("files.json")) {
  try {
    const allProjects = JSON.parse(
      fs.readFileSync("files.json", { encoding: "utf-8" }),
    );

    let limit = Infinity;
    const limitIdx = process.argv.indexOf("--limit");
    if (limitIdx !== -1 && process.argv[limitIdx + 1]) {
      limit = parseInt(process.argv[limitIdx + 1], 10);
    }

    const isForce =
      process.argv.includes("-force") || process.env.FORCE === "true";
    if (isForce) {
      process.env.FORCE = "true";
    }

    let scheduledCount = 0;
    for (const project of allProjects) {
      const pendingFiles = project.files.filter(
        (file: any) => isForce || !file.downloaded,
      );
      if (pendingFiles.length > 0 && scheduledCount < limit) {
        hasFilesToDownload = true;
        break;
      }
    }
  } catch (error) {
    // If files.json is malformed or has issues, let Playwright run to expose the error
    hasFilesToDownload = true;
  }
}

if (!hasFilesToDownload) {
  console.log("No pending files to download.");
  process.exit(0);
}

export default defineConfig({
  testDir: "./automations",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  timeout: (Number(process.env.WAIT_TIMEOUT) || 0) + 120 * 1000,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "setup",
      testMatch: /.*\.setup\.ts/,
    },
    {
      name: "download",
      use: {
        ...devices["Desktop Chrome"],
        storageState: ".auth/user.json",
        launchOptions: {
          args: [
            "--disable-features=DownloadRestrictions,ExternalProtocolDialog,PrivateNetworkAccessPermissionPrompt",
            "--disable-features=PrivateNetworkAccessSendPreflights",
          ],
        },
      },
      dependencies: ["setup"],
    },
  ],
});
