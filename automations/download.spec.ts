import { test } from "@playwright/test";
import fs from "node:fs";
import dotenv from "dotenv";

dotenv.config();

const projects = JSON.parse(
  fs.readFileSync("files.json", { encoding: "utf-8" }),
).filter((project: any) => project.files.some((file: any) => !file.downloaded));

for (const project of projects) {
  const projectName = project.name || "Drafts";
  const teamId = project.team_id || null;

  test.describe(`project: ${projectName} (${project.id})`, () => {
    for (const file of project.files.filter((file: any) => !file.downloaded)) {
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

        file.downloaded = true;
        fs.writeFileSync("files.json", JSON.stringify(projects, null, 2));

        await page.waitForTimeout(Number(process.env.WAIT_TIMEOUT) || 10000);
      });
    }
  });
}
