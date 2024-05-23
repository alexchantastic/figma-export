import { test } from "@playwright/test";
import fs from "node:fs";
import dotenv from "dotenv";

dotenv.config();

const projects = JSON.parse(
  fs.readFileSync("files.json", { encoding: "utf-8" }),
);

for (const project of projects) {
  test.describe(`project: ${project.name} (${project.id})`, () => {
    for (const file of project.files) {
      test(`file: ${file.name} (${file.key})`, async ({ page }) => {
        await page.goto(`https://www.figma.com/design/${file.key}/`);

        await page.locator(".view.gpu-view-content canvas").click();

        const downloadPromise = page.waitForEvent("download");

        await page.getByRole("button", { name: "Main menu" }).click();
        await page.getByTestId("dropdown-option-File").click();
        await page.getByTestId("dropdown-option-Save local copy…").click();

        const download = await downloadPromise;
        await download.saveAs(
          `${process.env.DOWNLOAD_PATH!}${project.name} (${project.id})/${file.name} (${file.key}).fig`,
        );

        await page.waitForTimeout(Number(process.env.WAIT_TIMEOUT) || 0);
      });
    }
  });
}
