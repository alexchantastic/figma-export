import test from "node:test";
import assert from "node:assert/strict";
import { navigateToFile } from "../dist/navigation.js";
function fixture({
  url = "https://www.figma.com/design/A",
  link = true,
  clickError = false,
  wrongDestination = false,
} = {}) {
  const calls = [];
  const page = {
    url: () => url,
    locator(selector) {
      calls.push(["selector", selector]);
      return {
        first() {
          return {
            async count() {
              return link ? 1 : 0;
            },
            async click() {
              calls.push(["click"]);
              if (clickError) throw new Error("stale link");
              url =
                "https://www.figma.com/design/" +
                (wrongDestination ? "OTHER" : "B");
            },
          };
        },
      };
    },
    async waitForURL(predicate) {
      calls.push(["wait"]);
      if (!predicate(new URL(url))) throw new Error("wrong destination");
    },
    async goto(destination) {
      calls.push(["goto", destination]);
      url = destination;
    },
  };
  return { calls, page };
}
test("existing Figma link is followed without a forced document navigation", async () => {
  const f = fixture();
  await navigateToFile(f.page, "B", 30000);
  assert.ok(f.calls.some((c) => c[0] === "click"));
  assert.ok(!f.calls.some((c) => c[0] === "goto"));
});
test("missing in-app link falls back to same-tab document navigation", async () => {
  const f = fixture({ link: false });
  await navigateToFile(f.page, "B", 30000);
  assert.deepEqual(f.calls.at(-1), ["goto", "https://www.figma.com/design/B"]);
});
test("initial blank page navigates normally without probing in-app UI", async () => {
  const f = fixture({ url: "about:blank" });
  await navigateToFile(f.page, "B", 30000);
  assert.deepEqual(f.calls, [["goto", "https://www.figma.com/design/B"]]);
});
test("stale links fall back rather than failing the download", async () => {
  const f = fixture({ clickError: true });
  await navigateToFile(f.page, "B", 30000);
  assert.equal(f.calls.at(-1)[0], "goto");
});
test("wrong destination is not accepted as the requested file", async () => {
  const f = fixture({ wrongDestination: true });
  await navigateToFile(f.page, "B", 30000);
  assert.deepEqual(f.calls.at(-1), ["goto", "https://www.figma.com/design/B"]);
});
test("selectors use exact file boundaries and exclude new-tab/download links", async () => {
  const f = fixture();
  await navigateToFile(f.page, "B", 30000);
  const selector = f.calls[0][1];
  assert.match(selector, /target=/);
  assert.match(selector, /download/);
  assert.ok(selector.includes('href="/design/B"'));
  assert.ok(selector.includes('href^="/design/B/"'));
  assert.ok(!selector.includes('href^="/design/B"'));
});
test("invalid keys fail before touching the page", async () => {
  const f = fixture();
  await assert.rejects(navigateToFile(f.page, 'B"]', 30000), /Invalid/);
  assert.deepEqual(f.calls, []);
});
