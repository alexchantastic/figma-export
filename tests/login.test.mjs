import test from "node:test";
import assert from "node:assert/strict";
import {
  login,
  FigmaApiError,
  browserAuthenticated,
  AuthStore,
} from "../dist/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
function fixture(overrides = {}) {
  const calls = [];
  const steps = {
    async savedToken() {
      calls.push("saved-token");
      return "saved";
    },
    async validateToken(token) {
      calls.push("validate:" + token);
    },
    async requestToken() {
      calls.push("request-token");
      return "replacement";
    },
    async saveToken(token) {
      calls.push("save:" + token);
    },
    async browserAuthenticated() {
      calls.push("browser-check");
      return true;
    },
    async loginBrowser(force) {
      calls.push("browser-login:" + force);
    },
    report(message) {
      calls.push("report:" + message);
    },
    ...overrides,
  };
  return { calls, steps };
}
test("default login checks both credentials and skips valid ones", async () => {
  const { calls, steps } = fixture();
  await login({}, steps);
  assert.ok(calls.includes("validate:saved"));
  assert.ok(calls.includes("browser-check"));
  assert.ok(!calls.includes("request-token"));
  assert.ok(!calls.some((c) => c.startsWith("browser-login:")));
});
test("default login configures both missing credentials", async () => {
  const f = fixture({
    async savedToken() {
      return undefined;
    },
    async browserAuthenticated() {
      return false;
    },
  });
  await login({}, f.steps);
  assert.ok(f.calls.includes("request-token"));
  assert.ok(f.calls.includes("save:replacement"));
  assert.ok(f.calls.includes("browser-login:false"));
});
test("a valid token is reused while missing browser authentication is configured", async () => {
  const f = fixture({
    async browserAuthenticated() {
      return false;
    },
  });
  await login({}, f.steps);
  assert.ok(!f.calls.includes("request-token"));
  assert.ok(f.calls.includes("browser-login:false"));
});
test("expired token is replaced without repeating a valid browser login", async () => {
  const f = fixture({
    async validateToken(token) {
      if (token === "saved") throw new FigmaApiError(403, "expired");
    },
  });
  await login({}, f.steps);
  assert.ok(f.calls.includes("save:replacement"));
  assert.ok(!f.calls.includes("browser-login:false"));
});
test("only-token never inspects or opens the browser", async () => {
  const f = fixture();
  await login({ onlyToken: true }, f.steps);
  assert.ok(!f.calls.includes("browser-check"));
});
test("only-browser never reads or requests a token", async () => {
  const f = fixture({
    async browserAuthenticated() {
      return false;
    },
  });
  await login({ onlyBrowser: true }, f.steps);
  assert.deepEqual(
    f.calls.filter((c) => !c.startsWith("report:")),
    ["browser-login:false"],
  );
});
test("force skips probes and explicitly replaces both selected credentials", async () => {
  const f = fixture();
  await login({ force: true }, f.steps);
  assert.ok(!f.calls.includes("saved-token"));
  assert.ok(!f.calls.includes("browser-check"));
  assert.ok(f.calls.includes("request-token"));
  assert.ok(f.calls.includes("browser-login:true"));
});
test("only-browser force does not replace token", async () => {
  const f = fixture();
  await login({ onlyBrowser: true, force: true }, f.steps);
  assert.deepEqual(
    f.calls.filter((c) => !c.startsWith("report:")),
    ["browser-login:true"],
  );
});
test("token-stdin replaces token while still checking browser by default", async () => {
  const f = fixture();
  await login({ tokenStdin: true }, f.steps);
  assert.ok(f.calls.includes("request-token"));
  assert.ok(!f.calls.includes("saved-token"));
  assert.ok(f.calls.includes("browser-check"));
});
test("network errors do not replace tokens but do not block browser setup", async () => {
  const f = fixture({
    async validateToken() {
      throw new Error("network failed");
    },
    async browserAuthenticated() {
      return false;
    },
  });
  await assert.rejects(login({}, f.steps), /network failed/);
  assert.ok(!f.calls.includes("request-token"));
  assert.ok(f.calls.includes("browser-login:false"));
});
test("browser verification error does not silently launch interactive login", async () => {
  const f = fixture({
    async browserAuthenticated() {
      throw new Error("Cannot verify browser");
    },
  });
  await assert.rejects(login({}, f.steps), /Cannot verify browser/);
  assert.ok(!f.calls.some((c) => c.startsWith("browser-login:")));
});
test("token setup failure still attempts the browser flow", async () => {
  const f = fixture({
    async savedToken() {
      return undefined;
    },
    async requestToken() {
      throw new Error("cancelled");
    },
    async browserAuthenticated() {
      return false;
    },
  });
  await assert.rejects(login({}, f.steps), /cancelled/);
  assert.ok(f.calls.includes("browser-login:false"));
});
test("mutually exclusive flags fail before side effects", async () => {
  const f = fixture();
  await assert.rejects(
    login({ onlyToken: true, onlyBrowser: true }, f.steps),
    /not both/,
  );
  await assert.rejects(
    login({ onlyBrowser: true, tokenStdin: true }, f.steps),
    /cannot be combined/,
  );
  assert.deepEqual(f.calls, []);
});
test("empty replacement token is rejected without saving", async () => {
  const f = fixture({
    async requestToken() {
      return " ";
    },
  });
  await assert.rejects(
    login({ onlyToken: true, force: true }, f.steps),
    /empty/,
  );
  assert.ok(!f.calls.some((c) => c.startsWith("save:")));
});
test("browser probe returns false without Chromium when no session is configured", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "figma-login-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = process.env.FIGMA_AUTH_COOKIE;
  delete process.env.FIGMA_AUTH_COOKIE;
  try {
    assert.equal(await browserAuthenticated(new AuthStore(dir)), false);
  } finally {
    if (previous !== undefined) process.env.FIGMA_AUTH_COOKIE = previous;
  }
});
