import test from "node:test";
import assert from "node:assert/strict";
import { parseDuration, isFresh } from "../dist/freshness.js";
test("durations support seconds minutes hours and days", () => {
  assert.equal(parseDuration("30s"), 30000);
  assert.equal(parseDuration("1m"), 60000);
  assert.equal(parseDuration("30m"), 1800000);
  assert.equal(parseDuration("4h"), 14400000);
  assert.equal(parseDuration("1d"), 86400000);
  assert.equal(parseDuration(), 0);
});
test("ambiguous zero negative and unsafe durations fail", () => {
  for (const value of [
    "1",
    "0m",
    "-1m",
    "Infinityh",
    "1ms",
    "4H",
    "0.00001s",
    "999999999999999999999d",
  ])
    assert.throws(() => parseDuration(value));
});
test("age is relative to successful check and never accepts future timestamps", () => {
  assert.equal(
    isFresh("2026-01-01T00:00:00Z", 60000, Date.parse("2026-01-01T00:00:30Z")),
    true,
  );
  assert.equal(
    isFresh("2026-01-01T00:00:00Z", 60000, Date.parse("2026-01-01T00:01:00Z")),
    false,
  );
  assert.equal(
    isFresh("2026-01-01T00:01:00Z", 60000, Date.parse("2026-01-01T00:00:00Z")),
    false,
  );
});
