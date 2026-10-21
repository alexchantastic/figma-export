import test from "node:test";
import assert from "node:assert/strict";
import { RestFigmaApi } from "../dist/index.js";
import { createProgressLogger } from "../dist/progress.js";

test("API request progress arrives before the network operation completes without credentials", async () => {
  const events = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const api = new RestFigmaApi(
    "never-log-this-token",
    async () => {
      await gate;
      return Response.json({
        file: {
          name: "A",
          version: "1",
          last_touched_at: "2026-10-20T02:00:00Z",
          editorType: "figma",
        },
      });
    },
    (event) => events.push(event),
  );
  const pending = api.file("ABC");
  assert.equal(events.length, 1);
  assert.match(events[0].message, /GET.*ABC.*meta/);
  assert.ok(!JSON.stringify(events).includes("never-log-this-token"));
  release();
  await pending;
  assert.match(events.at(-1).message, /200/);
});
test("progress logger emits immediately and sanitizes terminal controls", () => {
  const lines = [];
  const logger = createProgressLogger((line) => lines.push(line));
  try {
    logger.report({ phase: "file", message: "File\nBad\u001b[31m" });
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes("\n"));
    assert.ok(!lines[0].includes("\u001b"));
  } finally {
    logger.stop();
  }
});
test("long waits receive heartbeats that stop after cleanup", async () => {
  const lines = [];
  const logger = createProgressLogger((line) => lines.push(line), 10);
  try {
    logger.report({ phase: "browser", message: "Waiting for editor" });
    await new Promise((resolve) => setTimeout(resolve, 45));
    assert.ok(
      lines.some(
        (line) =>
          line.includes("Still working") && line.includes("Waiting for editor"),
      ),
    );
  } finally {
    logger.stop();
  }
  const count = lines.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(lines.length, count);
});
