import type { Page } from "@playwright/test";
import { execFile } from "node:child_process";
import path from "node:path";

const message = "Figma verification required. Complete it in Chromium.";

function notifyVerification() {
  process.stderr.write(message + "\n");
  if (process.platform !== "win32") return;

  const script = path.join(__dirname, "verification-notification.ps1");
  execFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
    { windowsHide: true },
    (error) => {
      if (error) process.stderr.write("Could not show the Windows notification.\n");
    },
  );
}

export function watchForVerification(page: Page): () => void {
  const prompt = page.getByText("Figma needs to verify you are not a bot.", {
    exact: true,
  });
  let wasVisible = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;

  async function check() {
    const visible = await prompt.isVisible().catch(() => undefined);
    if (stopped || page.isClosed()) return;

    if (visible !== undefined) {
      if (visible && !wasVisible) notifyVerification();
      wasVisible = visible;
    }
    timer = setTimeout(check, 1000);
  }

  timer = setTimeout(check, 1000);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

