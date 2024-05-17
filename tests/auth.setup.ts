import { test as setup } from "@playwright/test";
import dotenv from "dotenv";

dotenv.config();

const authFile = ".auth/user.json";

setup("authenticate", async ({ page }) => {
  await page.goto("https://www.figma.com/login");

  await page.getByRole("textbox", { name: "email" }).fill(process.env.EMAIL!);
  await page
    .getByRole("textbox", { name: "password" })
    .fill(process.env.PASSWORD!);

  await page.getByRole("button", { name: "log in" }).click();

  await page.waitForURL(
    "https://www.figma.com/files/recents-and-sharing/recently-viewed**",
  );

  await page.context().storageState({ path: authFile });
});
