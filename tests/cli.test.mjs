import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
async function fixture(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "figma-cli-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const env = {
    ...process.env,
    FIGMA_ACCESS_TOKEN: "",
    FIGMA_AUTH_COOKIE: "",
    XDG_CONFIG_HOME: path.join(cwd, "auth"),
    APPDATA: path.join(cwd, "auth"),
  };
  const run = (...args) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
  return { cwd, run };
}
test("help leaves the working directory untouched", async (t) => {
  const f = await fixture(t);
  const result = f.run("--help");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /figma-files-sync/);
  assert.deepEqual(await readdir(f.cwd), []);
});
test("empty fetch and sync work without credentials or a browser", async (t) => {
  const f = await fixture(t);
  for (const command of ["fetch", "sync"]) {
    const result = f.run(command, "--json");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { items: [], errors: [] });
  }
  assert.deepEqual(await readdir(f.cwd), []);
});
test("auth status uses structured output and does not need credentials", async (t) => {
  const f = await fixture(t);
  const result = f.run("auth", "status", "--json");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    tokenConfigured: false,
    browserSessionSaved: false,
    cookieOverride: false,
    validity: "not-checked",
  });
});
test("invalid add leaves no manifest", async (t) => {
  const f = await fixture(t);
  const result = f.run("add", "https://evil.example/design/A", "--json");
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).error, /Figma|figma/);
  assert.deepEqual(await readdir(f.cwd), []);
});
test("help ignores malformed manifest and leaves it unchanged", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.cwd, ".sync.fig.json"), "invalid");
  const result = f.run("--help");
  assert.equal(result.status, 0);
  assert.equal(
    await readFile(path.join(f.cwd, ".sync.fig.json"), "utf8"),
    "invalid",
  );
});
test("noninteractive token setup fails with instructions, never hangs", async (t) => {
  const f = await fixture(t);
  const result = f.run("login", "--only-token");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /token-stdin/);
});
test("library import has no directory side effects", async (t) => {
  const f = await fixture(t);
  const url = new URL("../dist/index.js", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "await import(" + JSON.stringify(url) + ")"],
    { cwd: f.cwd, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readdir(f.cwd), []);
});

test("headed and no-headless are accepted before and after the subcommand", async (t) => {
  const f = await fixture(t);
  for (const args of [
    ["--no-headless", "fetch", "--json"],
    ["fetch", "--no-headless", "--json"],
    ["fetch", "--headed", "--json"],
  ]) {
    const r = f.run(...args);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { items: [], errors: [] });
    assert.match(r.stderr, /Starting operation/);
    assert.match(r.stderr, /Reading manifests/);
  }
});
test("operation failures still flush progress to stderr without corrupting JSON", async (t) => {
  const f = await fixture(t);
  const r = f.run("add", "https://figma.com/files/folder/123", "--json");
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error, /No Figma API token/);
  assert.match(r.stderr, /Loading Figma API credentials/);
  assert.match(r.stderr, /Listing Figma folder 123/);
});

test("concurrency accepts 1–3 tabs and rejects invalid values before work", async (t) => {
  const f = await fixture(t);
  for (const value of ["1", "2", "3"]) {
    const r = f.run("fetch", "--concurrency", value, "--json");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { items: [], errors: [] });
  }
  for (const value of ["0", "4", "-1", "1.5", "abc"]) {
    const r = f.run("sync", "--concurrency", value);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Concurrency/);
  }
});

test("CLI version matches the published package metadata", async (t) => {
  const f = await fixture(t);
  const metadata = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const result = f.run("--version");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), metadata.version);
});

test("version, auth and failed login do not create project manifests", async (t) => {
  const f = await fixture(t);
  for (const args of [
    ["--version"],
    ["auth", "status"],
    ["logout"],
    ["login", "--only-token"],
  ]) {
    f.run(...args);
    assert.deepEqual(await readdir(f.cwd), [], args.join(" "));
  }
});
test("failed add without API credentials leaves no empty manifest or lock", async (t) => {
  const f = await fixture(t);
  const r = f.run("add", "https://figma.com/design/A", "--json");
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error, /No Figma API token/);
  assert.deepEqual(await readdir(f.cwd), []);
});
test("data commands reject malformed manifests without altering them", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.cwd, ".sync.fig.json"), "invalid");
  const r = f.run("fetch", "--json");
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error, /Invalid/);
  assert.equal(
    await readFile(path.join(f.cwd, ".sync.fig.json"), "utf8"),
    "invalid",
  );
});

test("api-concurrency accepts an independent limit and rejects invalid values", async (t) => {
  const f = await fixture(t);
  let r = f.run(
    "fetch",
    "--api-concurrency",
    "2",
    "--concurrency",
    "1",
    "--json",
  );
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { items: [], errors: [] });
  for (const value of ["0", "4", "abc", "1.5"]) {
    r = f.run("fetch", "--api-concurrency", value);
    assert.notEqual(r.status, 0);
  }
});

test("ignore durations work before/after subcommands and fail fast when invalid", async (t) => {
  const f = await fixture(t);
  for (const args of [
    ["--ignore", "1m", "fetch", "--json"],
    ["sync", "--ignore", "4h", "--json"],
    ["fetch", "--ignore", "30m", "--json"],
  ]) {
    const r = f.run(...args);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { items: [], errors: [] });
  }
  for (const value of ["5", "0m", "abc", "-2h"]) {
    const r = f.run("fetch", "--ignore", value);
    assert.notEqual(r.status, 0);
  }
  assert.deepEqual(await readdir(f.cwd), []);
});
