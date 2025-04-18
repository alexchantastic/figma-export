import { test as setup, expect } from "@playwright/test";
import dotenv from "dotenv";

dotenv.config();

const authFile = ".auth/user.json";

setup("authenticate", async ({ page }) => {
  const FIGMA_AUTH_COOKIE = process.env.FIGMA_AUTH_COOKIE;

  if (FIGMA_AUTH_COOKIE) {
    const authCookie = {
      name: "__Host-figma.authn",
      value: FIGMA_AUTH_COOKIE,
      domain: "www.figma.com",
      path: "/",
      httpOnly: true,
      secure: true,
    };

    await page.context().addCookies([authCookie]);

    await page.goto("https://www.figma.com/files");
  } else {
    await page.goto("https://www.figma.com/login");

    await page
      .getByRole("textbox", { name: "email" })
      .fill(process.env.FIGMA_EMAIL!);

    const passwordInput = page.getByRole("textbox", { name: "password" });

    if (!(await passwordInput.isVisible())) {
      await page.getByRole("button", { name: "continue with email" }).click();
    }

    await passwordInput.fill(process.env.FIGMA_PASSWORD!);

    await page.getByRole("button", { name: "log in" }).click();
  }

  await expect(page.getByTestId("ProfileButton")).toBeAttached({
    timeout: 10 * 1000,
  });

  await page.context().storageState({ path: authFile });
});
