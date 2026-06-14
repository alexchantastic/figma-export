import { test } from "@playwright/test";
import fs from "node:fs";
import dotenv from "dotenv";

dotenv.config();

const allProjects = JSON.parse(
  fs.readFileSync("files.json", { encoding: "utf-8" }),
);

let limit = Infinity;
const limitIdx = process.argv.indexOf("--limit");
if (limitIdx !== -1 && process.argv[limitIdx + 1]) {
  limit = parseInt(process.argv[limitIdx + 1], 10);
}

const isForce = process.env.FORCE === "true";

const projectsToDownload = [];
let scheduledCount = 0;

for (const project of allProjects) {
  const pendingFiles = project.files.filter((file: any) => isForce || !file.downloaded);
  if (pendingFiles.length === 0 || scheduledCount >= limit) {
    continue;
  }

  const filesForThisProject = pendingFiles.slice(0, limit - scheduledCount);
  projectsToDownload.push({
    ...project,
    files: filesForThisProject,
  });
  scheduledCount += filesForThisProject.length;
}

for (const project of projectsToDownload) {
  const projectName = project.name || "Drafts";
  const teamId = project.team_id || null;

  test.describe(`project: ${projectName} (${project.id})`, () => {
    for (const file of project.files) {
      test(`file: ${file.name} (${file.key})`, async ({ page }) => {
        await page.goto(`https://www.figma.com/design/${file.key}/`);

        // Dismiss "Need to use the desktop app or installed fonts?" dialog if it appears
        await page.getByRole("button", { name: "Close" }).click({ timeout: 5000 }).catch(() => {});

        const downloadPromise = page.waitForEvent("download");

        await page.locator("[data-tooltip='main-menu']").click();
        await page.locator("[aria-controls^='mainMenu.file-menu']").click();
        await page.getByText("Save local copy…", { exact: true }).click();

        const download = await downloadPromise;
        const suggestedFilename = download.suggestedFilename();
        const filename = suggestedFilename.match(/.*(?=\.[\w\d]+)/)![0];
        const extension = suggestedFilename.replace(filename + ".", "");
        await download.saveAs(
          `${process.env.DOWNLOAD_PATH!}/${teamId ? teamId + "/" : ""}${projectName} (${project.id})/${filename} (${file.key}).${extension}`,
        );

        // Update the original object reference
        const originalProject = allProjects.find(
          (p: any) => p.id === project.id,
        );
        const originalFile = originalProject.files.find(
          (f: any) => f.key === file.key,
        );
        originalFile.downloaded = true;

        fs.writeFileSync("files.json", JSON.stringify(allProjects, null, 2));

        await page.waitForTimeout(Number(process.env.WAIT_TIMEOUT) || 10000);
      });
    }
  });
}
