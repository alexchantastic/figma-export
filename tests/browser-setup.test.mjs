import test from "node:test";
import assert from "node:assert/strict";
import { ensureBrowser } from "../dist/browser-setup.js";
function fixture(options = {}) {
  let available = false;
  const calls = [];
  const steps = {
    interactive: true,
    async installed() {
      calls.push("check");
      return available;
    },
    async confirm() {
      calls.push("confirm");
      return true;
    },
    async install() {
      calls.push("install");
      available = true;
    },
    ...options,
  };
  return { calls, steps };
}
test("installed browser skips confirmation and installation", async () => {
  const f = fixture({
    async installed() {
      return true;
    },
  });
  await ensureBrowser(f.steps);
  assert.deepEqual(f.calls, []);
});
test("missing browser offers installation and verifies result", async () => {
  const f = fixture();
  await ensureBrowser(f.steps);
  assert.deepEqual(f.calls, ["check", "confirm", "install", "check"]);
});
test("declining never downloads", async () => {
  const f = fixture({
    async confirm() {
      return false;
    },
  });
  await assert.rejects(ensureBrowser(f.steps), /declined/);
  assert.ok(!f.calls.includes("install"));
});
test("noninteractive execution fails without prompting", async () => {
  const f = fixture({ interactive: false });
  await assert.rejects(ensureBrowser(f.steps), /install-browser/);
  assert.deepEqual(f.calls, ["check"]);
});
test("explicit installation flag bypasses confirmation", async () => {
  const f = fixture({ interactive: false });
  await ensureBrowser(f.steps, true);
  assert.deepEqual(f.calls, ["check", "install", "check"]);
});
test("explicit installation flag still skips installed browsers", async () => {
  const f = fixture({
    async installed() {
      return true;
    },
  });
  await ensureBrowser(f.steps, true);
  assert.deepEqual(f.calls, []);
});
test("installation failures propagate without looping", async () => {
  const f = fixture({
    async install() {
      throw new Error("download failed");
    },
  });
  await assert.rejects(ensureBrowser(f.steps), /download failed/);
  assert.deepEqual(f.calls, ["check", "confirm"]);
});
test("failed post-install check is reported", async () => {
  const f = fixture({ async install() {} });
  await assert.rejects(ensureBrowser(f.steps), /still unavailable/);
  assert.deepEqual(f.calls, ["check", "confirm", "check"]);
});
test("OS errors do not offer or trigger a reinstall", async () => {
  const f = fixture({
    async installed() {
      throw new Error("permission denied");
    },
  });
  await assert.rejects(ensureBrowser(f.steps), /permission denied/);
  assert.deepEqual(f.calls, []);
});
