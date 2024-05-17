import { test } from "@playwright/test";
import fs from "node:fs";
import dotenv from "dotenv";

dotenv.config();

const files = JSON.parse(fs.readFileSync("files.json", { encoding: "utf-8" }));

for (const file of files.files) {
  test(`download ${file.name}`, async ({ page }) => {
    await page.goto(`https://www.figma.com/design/${file.key}/`);

    await page
      .getByTestId("objects-panel")
      .evaluate((node) => node.childNodes.length > 0);

    const downloadPromise = page.waitForEvent("download");

    await page.getByRole("button", { name: "Main menu" }).click();
    await page.getByTestId("dropdown-option-File").click();
    await page.getByTestId("dropdown-option-Save local copy…").click();

    const download = await downloadPromise;
    await download.saveAs(
      process.env.DOWNLOAD_PATH! +
        files.name +
        "/" +
        download.suggestedFilename(),
    );
  });
}
