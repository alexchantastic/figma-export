import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  rm,
  unlink,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  createFigmaSync,
  ensureManifest,
  readManifest,
  parseFigmaUrl,
  FigmaApiError,
  manifestSchema,
  emptyManifest,
  planFile,
  RestFigmaApi,
  AuthStore,
} from "../dist/index.js";
import { withManifest, allocateName } from "../dist/manifest.js";
import { verifyNativeFile } from "../dist/download.js";

const date = "2026-10-20T02:00:00Z";
async function fixture(t, options = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), "figma-files-sync-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const versions = new Map();
  const listings = new Map();
  const downloads = [];
  const api = {
    async file(key) {
      const value = versions.get(key);
      if (value instanceof Error) throw value;
      return {
        key,
        name: "File " + key,
        version: "1",
        modifiedAt: date,
        editorType: "figma",
        ...value,
      };
    },
    async folder(id) {
      const value = listings.get(id);
      if (value instanceof Error) throw value;
      return value ?? { name: "Folder " + id, files: [], folders: [] };
    },
    async validateToken() {},
  };
  const downloader = {
    async download(key, destination) {
      downloads.push(key);
      await writeFile(
        destination,
        "fig-kiwi content " + key + " " + (versions.get(key)?.version ?? "1"),
      );
    },
    async close() {},
  };
  const client = createFigmaSync({ api, downloader, ...options });
  t.after(() => client.close());
  return { cwd, client, versions, listings, downloads, api, downloader };
}

test("empty manifest and idempotent individual add", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await ensureManifest(f.cwd), emptyManifest());
  let r = await f.client.add(
    "https://www.figma.com/design/ABC/Home?node-id=1-2",
    { cwd: f.cwd },
  );
  assert.equal(r.items[0].status, "downloaded");
  await f.client.add("https://www.figma.com/file/ABC/Home", { cwd: f.cwd });
  assert.equal(f.downloads.length, 1);
  const m = await readManifest(f.cwd);
  assert.equal(m.files.length, 1);
  assert.equal(
    m.files[0].url,
    "https://www.figma.com/design/ABC/Home?node-id=1-2",
  );
  assert.equal(m.folder, null);
  assert.deepEqual((await readdir(f.cwd)).sort(), [
    ".sync.fig.json",
    "File ABC.fig",
  ]);
});
test("fetch observes a new version but never marks it synchronized or downloads", async (t) => {
  const f = await fixture(t);
  await f.client.add("https://figma.com/design/ABC", { cwd: f.cwd });
  f.versions.set("ABC", { version: "2" });
  const r = await f.client.fetch({ cwd: f.cwd });
  assert.equal(r.items[0].status, "modified");
  assert.equal(f.downloads.length, 1);
  let m = await readManifest(f.cwd);
  assert.equal(m.files[0].remote.version, "2");
  assert.equal(m.files[0].synced.version, "1");
  await f.client.sync({ cwd: f.cwd });
  m = await readManifest(f.cwd);
  assert.equal(m.files[0].synced.version, "2");
  await f.client.sync({ cwd: f.cwd });
  assert.equal(f.downloads.length, 2);
});
test("missing local file downloads again", async (t) => {
  const f = await fixture(t);
  await f.client.add("https://figma.com/design/ABC", { cwd: f.cwd });
  const m = await readManifest(f.cwd);
  await unlink(path.join(f.cwd, m.files[0].localPath));
  assert.equal(
    (await f.client.fetch({ cwd: f.cwd })).items[0].status,
    "missing",
  );
  await f.client.sync({ cwd: f.cwd });
  assert.equal(f.downloads.length, 2);
});
test("local changes conflict; force preserves backup before replacement", async (t) => {
  const f = await fixture(t);
  await f.client.add("https://figma.com/design/ABC", { cwd: f.cwd });
  const target = path.join(
    f.cwd,
    (await readManifest(f.cwd)).files[0].localPath,
  );
  await writeFile(target, "user changes");
  assert.equal(
    (await f.client.sync({ cwd: f.cwd })).items[0].status,
    "conflict",
  );
  assert.equal(f.downloads.length, 1);
  await f.client.sync({ cwd: f.cwd, force: true });
  const backup = (await readdir(f.cwd)).find((s) => s.includes(".backup-"));
  assert.ok(backup);
  assert.equal(
    await readFile(path.join(f.cwd, backup), "utf8"),
    "user changes",
  );
});
test("unavailable remote preserves existing local file and sync baseline", async (t) => {
  const f = await fixture(t);
  await f.client.add("https://figma.com/design/ABC", { cwd: f.cwd });
  f.versions.set("ABC", new FigmaApiError(404, "Unavailable"));
  const r = await f.client.sync({ cwd: f.cwd });
  assert.equal(r.items[0].status, "unavailable");
  const m = await readManifest(f.cwd);
  assert.equal(m.files[0].synced.version, "1");
  assert.equal(m.files[0].remote.availability, "unavailable");
  assert.ok(await readFile(path.join(f.cwd, m.files[0].localPath)));
});
test("folder discovery merges new files and preserves disappeared entries", async (t) => {
  const f = await fixture(t);
  f.listings.set("123", {
    name: "Wireframes",
    files: [{ key: "A", name: "Login" }],
    folders: [{ id: "456", name: "Mobile" }],
  });
  f.listings.set("456", {
    name: "Mobile",
    files: [{ key: "M", name: "Mobile" }],
    folders: [],
  });
  await f.client.add("https://figma.com/files/folder/123", {
    cwd: f.cwd,
    directory: "wireframes",
  });
  const dir = path.join(f.cwd, "wireframes");
  assert.equal((await readManifest(dir)).files.length, 1);
  assert.equal((await readManifest(path.join(dir, "Mobile"))).files.length, 1);
  f.listings.set("123", {
    name: "Wireframes",
    files: [{ key: "B", name: "Dashboard" }],
    folders: [{ id: "456", name: "Mobile" }],
  });
  await f.client.fetch({ cwd: f.cwd });
  assert.equal(f.downloads.length, 2);
  let m = await readManifest(dir);
  assert.equal(m.files.length, 2);
  assert.equal(m.files[0].remote.membership, "absent");
  assert.equal(m.files[1].synced, null);
  await f.client.sync({ cwd: f.cwd });
  assert.equal(f.downloads.length, 3);
  await f.client.add("https://figma.com/files/project/123", { cwd: f.cwd });
  m = await readManifest(dir);
  assert.equal(m.files.length, 2);
  assert.equal(f.downloads.length, 3);
});
test("partial folder discovery never erases entries or marks them removed", async (t) => {
  const f = await fixture(t);
  f.listings.set("123", {
    name: "Folder",
    files: [{ key: "A", name: "A" }],
    folders: [],
  });
  await f.client.add("https://figma.com/files/folder/123", {
    cwd: f.cwd,
    directory: "folder",
  });
  const dir = path.join(f.cwd, "folder");
  const before = await readManifest(dir);
  f.listings.set("123", new Error("Subfolder request failed"));
  const result = await f.client.fetch({ cwd: f.cwd });
  assert.equal(result.errors.length, 1);
  assert.deepEqual(await readManifest(dir), before);
});
test("failed downloads stay pending and preserve previously successful entries", async (t) => {
  const f = await fixture(t);
  await f.client.add("https://figma.com/design/A", { cwd: f.cwd });
  f.downloader.download = async () => {
    throw new Error("Failed download");
  };
  let r = await f.client.add("https://figma.com/design/B", { cwd: f.cwd });
  assert.equal(r.errors.length, 1);
  const m = await readManifest(f.cwd);
  assert.equal(m.files.length, 2);
  assert.equal(m.files[0].synced.version, "1");
  assert.equal(m.files[1].synced, null);
  r = await f.client.fetch({ cwd: f.cwd });
  assert.equal(r.items.find((i) => i.key === "B").status, "new");
});
test("remote edit during download preserves old copy and baseline", async (t) => {
  const f = await fixture(t);
  await f.client.add("https://figma.com/design/A", { cwd: f.cwd });
  const target = path.join(
    f.cwd,
    (await readManifest(f.cwd)).files[0].localPath,
  );
  const old = await readFile(target, "utf8");
  f.versions.set("A", { version: "2" });
  f.downloader.download = async (_key, temp) => {
    await writeFile(temp, "fig-kiwi new");
    f.versions.set("A", { version: "3" });
  };
  const result = await f.client.sync({ cwd: f.cwd });
  assert.equal(result.errors.length, 1);
  assert.equal(await readFile(target, "utf8"), old);
  assert.equal((await readManifest(f.cwd)).files[0].synced.version, "1");
});
test("local edit during download is not overwritten", async (t) => {
  const f = await fixture(t);
  await f.client.add("https://figma.com/design/A", { cwd: f.cwd });
  const target = path.join(
    f.cwd,
    (await readManifest(f.cwd)).files[0].localPath,
  );
  f.versions.set("A", { version: "2" });
  f.downloader.download = async (_key, temp) => {
    await writeFile(temp, "fig-kiwi new");
    await writeFile(target, "concurrent changes");
  };
  const result = await f.client.sync({ cwd: f.cwd });
  assert.equal(result.errors.length, 1);
  assert.equal(await readFile(target, "utf8"), "concurrent changes");
});
test("collisions do not overwrite untracked files or duplicate names", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.cwd, "Login.fig"), "unmanaged");
  f.versions.set("A", { name: "Login" });
  f.versions.set("B", { name: "LOGIN" });
  await f.client.add("https://figma.com/design/A", { cwd: f.cwd });
  await f.client.add("https://figma.com/design/B", { cwd: f.cwd });
  const m = await readManifest(f.cwd);
  assert.notEqual(
    m.files[0].localPath.toLowerCase(),
    m.files[1].localPath.toLowerCase(),
  );
  assert.equal(
    await readFile(path.join(f.cwd, "Login.fig"), "utf8"),
    "unmanaged",
  );
});
test("remote rename keeps stable local path without download", async (t) => {
  const f = await fixture(t);
  await f.client.add("https://figma.com/design/A", { cwd: f.cwd });
  const previous = (await readManifest(f.cwd)).files[0].localPath;
  f.versions.set("A", { name: "Renamed" });
  await f.client.sync({ cwd: f.cwd });
  const file = (await readManifest(f.cwd)).files[0];
  assert.equal(file.name, "Renamed");
  assert.equal(file.localPath, previous);
  assert.equal(f.downloads.length, 1);
});
test("malformed manifest fails closed and is not overwritten", async (t) => {
  const f = await fixture(t);
  const p = path.join(f.cwd, ".sync.fig.json");
  await writeFile(p, "{bad");
  await assert.rejects(f.client.fetch({ cwd: f.cwd }), /Invalid/);
  assert.equal(await readFile(p, "utf8"), "{bad");
});
test("future schema and duplicate identities rejected", () => {
  assert.equal(
    manifestSchema.safeParse({ ...emptyManifest(), schemaVersion: 2 }).success,
    false,
  );
  const file = {
    key: "A",
    url: "https://figma.com/design/A",
    name: "A",
    localPath: "A.fig",
    remote: null,
    synced: null,
  };
  assert.equal(
    manifestSchema.safeParse({ ...emptyManifest(), files: [file, file] })
      .success,
    false,
  );
  for (const localPath of ["../A.fig", "/A.fig", "CON.fig", "A\\B.fig"])
    assert.equal(
      manifestSchema.safeParse({
        ...emptyManifest(),
        files: [{ ...file, localPath }],
      }).success,
      false,
    );
});
test("symbolic link target and manifest are refused", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.cwd, "outside");
  await writeFile(outside, "unchanged");
  await symlink(outside, path.join(f.cwd, ".sync.fig.json"));
  await assert.rejects(ensureManifest(f.cwd), /non-regular/);
  await unlink(path.join(f.cwd, ".sync.fig.json"));
  await f.client.add("https://figma.com/design/A", { cwd: f.cwd });
  const p = path.join(f.cwd, (await readManifest(f.cwd)).files[0].localPath);
  await unlink(p);
  await symlink(outside, p);
  assert.equal((await f.client.sync({ cwd: f.cwd })).errors.length, 1);
  assert.equal(await readFile(outside, "utf8"), "unchanged");
});
test("concurrent directory lock prevents lost manifest updates", async (t) => {
  const f = await fixture(t);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let ready;
  const started = new Promise((resolve) => {
    ready = resolve;
  });
  const first = withManifest(f.cwd, async () => {
    ready();
    await gate;
  });
  await started;
  await assert.rejects(
    withManifest(f.cwd, async () => {}),
    /locked/,
  );
  release();
  await first;
});
test("non-design files are reported but never downloaded", async (t) => {
  const f = await fixture(t);
  f.versions.set("A", { editorType: "figjam" });
  await assert.rejects(
    f.client.add("https://figma.com/design/A", { cwd: f.cwd }),
    /Only Figma Design/,
  );
  assert.equal(f.downloads.length, 0);
});
test("safe names handle traversal, reserved names, and case collisions", async (t) => {
  const f = await fixture(t);
  assert.ok(!(await allocateName(f.cwd, "../../bad", "A", [])).includes("/"));
  assert.equal(await allocateName(f.cwd, "CON", "A", []), "Figma-CON.fig");
});
test("native sanity check rejects error pages but not unknown proprietary containers", async (t) => {
  const f = await fixture(t);
  const p = path.join(f.cwd, "candidate");
  for (const content of ["", "  <html>Error</html>", "{bad response}"]) {
    await writeFile(p, content);
    await assert.rejects(verifyNativeFile(p));
  }
  await writeFile(p, "future-binary-format");
  await verifyNativeFile(p);
});
test("URL parsing accepts supported links and rejects hostile or pinned URLs", () => {
  assert.equal(
    parseFigmaUrl("https://www.figma.com/files/999/project/123/Foo").id,
    "123",
  );
  assert.equal(
    parseFigmaUrl("https://figma.com/proto/ABC/Name?node-id=1-2").kind,
    "file",
  );
  for (const url of [
    "http://figma.com/design/A",
    "https://figma.com.evil/design/A",
    "https://user@figma.com/design/A",
    "https://figma.com/design/A?version-id=1",
    "https://figma.com/board/A",
    "A",
  ])
    assert.throws(() => parseFigmaUrl(url));
});
test("plan uses versions, not numeric ordering or timestamps alone", () => {
  const file = {
    remote: {
      availability: "available",
      version: "opaque-a",
      modifiedAt: date,
    },
    synced: { version: "opaque-b", modifiedAt: date, sha256: "x" },
  };
  assert.equal(planFile(file, { sha256: "x" }), "modified");
  file.remote.version = "opaque-b";
  assert.equal(planFile(file, { sha256: "x" }), "unchanged");
});
test("REST client uses metadata endpoint and validates payloads", async () => {
  const calls = [];
  const api = new RestFigmaApi("secret", async (url, init) => {
    calls.push({ url, init });
    return Response.json({
      file: {
        name: "A",
        version: "v1",
        last_touched_at: date,
        editorType: "figma",
      },
    });
  });
  assert.equal((await api.file("ABC")).version, "v1");
  assert.equal(calls[0].url, "https://api.figma.com/v1/files/ABC/meta");
  assert.equal(calls[0].init.headers["X-FIGMA-TOKEN"], "secret");
  await assert.rejects(
    new RestFigmaApi("secret", async () => Response.json({})).file("A"),
  );
});
test("REST errors do not expose tokens or arbitrary remote response content", async () => {
  const api = new RestFigmaApi(
    "private-token",
    async () => new Response("private-token", { status: 403 }),
  );
  await assert.rejects(
    api.file("A"),
    (error) =>
      error instanceof FigmaApiError &&
      !error.message.includes("private-token"),
  );
});
test("long Retry-After fails promptly rather than retrying too early", async () => {
  let calls = 0;
  const api = new RestFigmaApi("token", async () => {
    calls++;
    return new Response("", {
      status: 429,
      headers: { "Retry-After": "3600" },
    });
  });
  await assert.rejects(api.file("A"), /Rate limited/);
  assert.equal(calls, 1);
});
test("auth store writes credentials outside project manifest and removes them", async (t) => {
  const f = await fixture(t);
  const store = new AuthStore(path.join(f.cwd, "auth"));
  await store.saveToken("test-token");
  const config = JSON.parse(
    await readFile(path.join(store.directory, "config.json"), "utf8"),
  );
  assert.equal(config.token, "test-token");
  await store.logout();
  assert.deepEqual(await readdir(store.directory), []);
});
test("successful sync records the exact local hash", async (t) => {
  const f = await fixture(t);
  await f.client.add("https://figma.com/design/A", { cwd: f.cwd });
  const file = (await readManifest(f.cwd)).files[0];
  assert.equal(
    file.synced.sha256,
    createHash("sha256")
      .update(await readFile(path.join(f.cwd, file.localPath)))
      .digest("hex"),
  );
});

test("remote moves and repeated individual add reuse the established file", async (t) => {
  const f = await fixture(t);
  f.listings.set("123", {
    name: "Root",
    files: [{ key: "A", name: "A" }],
    folders: [{ id: "456", name: "Child" }],
  });
  await f.client.add("https://figma.com/files/folder/123", {
    cwd: f.cwd,
    directory: "root",
  });
  f.listings.set("123", {
    name: "Root",
    files: [],
    folders: [{ id: "456", name: "Child" }],
  });
  f.listings.set("456", {
    name: "Child",
    files: [{ key: "A", name: "A" }],
    folders: [],
  });
  await f.client.sync({ cwd: f.cwd });
  await f.client.add("https://figma.com/design/A", { cwd: f.cwd });
  assert.equal(f.downloads.length, 1);
  assert.ok(!(await readdir(f.cwd)).includes(".sync.fig.json"));
  assert.equal(
    (await readManifest(path.join(f.cwd, "root", "Child"))).files.length,
    0,
  );
});
test("recursive folder cycles do not create an unbounded directory tree", async (t) => {
  const f = await fixture(t);
  f.listings.set("123", {
    name: "Root",
    files: [],
    folders: [{ id: "456", name: "Child" }],
  });
  f.listings.set("456", {
    name: "Child",
    files: [],
    folders: [{ id: "123", name: "Root again" }],
  });
  await f.client.add("https://figma.com/files/folder/123", {
    cwd: f.cwd,
    directory: "root",
  });
  assert.deepEqual(await readdir(path.join(f.cwd, "root", "Child")), [
    ".sync.fig.json",
  ]);
});
test("unknown manifest extension data survives fetch and sync", async (t) => {
  const f = await fixture(t);
  await f.client.add("https://figma.com/design/A", { cwd: f.cwd });
  await withManifest(f.cwd, async (m) => {
    m.external = { app: "consumer" };
    m.files[0].remote.external = "remote";
    m.files[0].synced.external = "local";
  });
  f.versions.set("A", { version: "2" });
  await f.client.sync({ cwd: f.cwd });
  const m = await readManifest(f.cwd);
  assert.equal(m.external.app, "consumer");
  assert.equal(m.files[0].remote.external, "remote");
  assert.equal(m.files[0].synced.external, "local");
});
test("REST folder discovery uses both v2 endpoints and rejects partial results", async () => {
  const calls = [];
  const api = new RestFigmaApi("token", async (url) => {
    calls.push(url);
    return Response.json(
      url.endsWith("/files")
        ? { name: "Root", files: [{ key: "A", name: "A" }] }
        : { folders: [{ id: "456", name: "Child" }] },
    );
  });
  assert.deepEqual(await api.folder("123"), {
    name: "Root",
    files: [{ key: "A", name: "A" }],
    folders: [{ id: "456", name: "Child" }],
  });
  assert.deepEqual(calls, [
    "https://api.figma.com/v2/folders/123/files",
    "https://api.figma.com/v2/folders/123/folders",
  ]);
  const broken = new RestFigmaApi("token", async (url) =>
    url.endsWith("/files")
      ? Response.json({ files: [] })
      : new Response("denied", { status: 403 }),
  );
  await assert.rejects(broken.folder("123"), /403/);
});
test("no-recursive skips child manifests and leaves them untouched", async (t) => {
  const f = await fixture(t);
  await f.client.add("https://figma.com/design/A", {
    cwd: f.cwd,
    directory: "child",
  });
  const before = await readManifest(path.join(f.cwd, "child"));
  f.versions.set("A", { version: "2" });
  const result = await f.client.fetch({ cwd: f.cwd, recursive: false });
  assert.deepEqual(result.items, []);
  assert.deepEqual(await readManifest(path.join(f.cwd, "child")), before);
});

test("sync progress reports folder counts and file stages before downloader runs", async (t) => {
  const events = [];
  const f = await fixture(t, { onProgress: (event) => events.push(event) });
  f.listings.set("123", {
    name: "Root",
    files: [{ key: "A", name: "A" }],
    folders: [],
  });
  const native = f.downloader.download;
  f.downloader.download = async (...args) => {
    assert.ok(events.some((event) => event.message.includes("Found 1 files")));
    assert.ok(
      events.some((event) => event.message.includes("Downloading file 1/1")),
    );
    return native(...args);
  };
  await f.client.add("https://figma.com/files/folder/123", {
    cwd: f.cwd,
    directory: "root",
  });
  assert.ok(
    events.some((event) =>
      event.message.includes("Verifying remote version after download"),
    ),
  );
  assert.ok(
    events.some((event) => event.message.includes("Hashing and committing")),
  );
});

test("concurrent sync overlaps two downloads without losing successful manifest entries", async (t) => {
  const f = await fixture(t, { concurrency: 2 });
  let active = 0,
    max = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  f.listings.set("123", {
    name: "Root",
    files: [
      { key: "A", name: "A" },
      { key: "B", name: "B" },
      { key: "C", name: "C" },
    ],
    folders: [],
  });
  const original = f.downloader.download;
  f.downloader.download = async (...args) => {
    active++;
    max = Math.max(max, active);
    if (active === 2) release();
    await gate;
    try {
      await original(...args);
    } finally {
      active--;
    }
  };
  const result = await f.client.add("https://figma.com/files/folder/123", {
    cwd: f.cwd,
    directory: "root",
  });
  assert.equal(max, 2);
  assert.deepEqual(result.errors, []);
  const m = await readManifest(path.join(f.cwd, "root"));
  assert.equal(m.files.length, 3);
  assert.ok(m.files.every((file) => file.synced?.version === "1"));
  await f.client.sync({ cwd: f.cwd });
  assert.equal(f.downloads.length, 3);
});
test("parallel failures preserve other worker successes and release locks only after completion", async (t) => {
  const f = await fixture(t, { concurrency: 3 });
  f.listings.set("123", {
    name: "Root",
    files: [
      { key: "A", name: "A" },
      { key: "B", name: "B" },
      { key: "C", name: "C" },
    ],
    folders: [],
  });
  const original = f.downloader.download;
  f.downloader.download = async (key, target) => {
    if (key === "B") throw new Error("native failed");
    await original(key, target);
  };
  const result = await f.client.add("https://figma.com/files/folder/123", {
    cwd: f.cwd,
    directory: "root",
  });
  assert.equal(result.errors.length, 1);
  const dir = path.join(f.cwd, "root");
  const m = await readManifest(dir);
  assert.equal(m.files.filter((file) => file.synced).length, 2);
  assert.equal(m.files.find((file) => file.key === "B").synced, null);
  assert.ok(!(await readdir(dir)).includes(".sync.fig.lock"));
});

test("failed and unsupported registrations do not persist empty manifests", async (t) => {
  const f = await fixture(t);
  f.versions.set("A", new FigmaApiError(404, "missing"));
  await assert.rejects(
    f.client.add("https://figma.com/design/A", { cwd: f.cwd }),
  );
  assert.deepEqual(await readdir(f.cwd), []);
  f.versions.set("B", { editorType: "figjam" });
  await assert.rejects(
    f.client.add("https://figma.com/design/B", { cwd: f.cwd }),
  );
  assert.deepEqual(await readdir(f.cwd), []);
});
test("adding a folder only creates its target manifest, not an empty parent", async (t) => {
  const f = await fixture(t);
  f.listings.set("123", { name: "Root", files: [], folders: [] });
  await f.client.add("https://figma.com/files/folder/123", {
    cwd: f.cwd,
    directory: "designs",
  });
  assert.ok(!(await readdir(f.cwd)).includes(".sync.fig.json"));
  assert.equal(
    (await readManifest(path.join(f.cwd, "designs"))).folder.id,
    "123",
  );
});

function pipelineGate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
test(
  "API producer discovers all later files while a single download remains blocked",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t, { concurrency: 1, apiConcurrency: 1 });
    const downloadStarted = pipelineGate(),
      releaseDownload = pipelineGate(),
      discovered = pipelineGate();
    const calls = [];
    const originalApi = f.api.file;
    const originalDownload = f.downloader.download;
    f.api.file = async (key) => {
      calls.push(key);
      if (key === "C") discovered.release();
      return originalApi(key);
    };
    f.downloader.download = async (key, target) => {
      if (key === "A") {
        downloadStarted.release();
        await releaseDownload.promise;
      }
      return originalDownload(key, target);
    };
    f.listings.set("123", {
      name: "Root",
      files: [
        { key: "A", name: "A" },
        { key: "B", name: "B" },
        { key: "C", name: "C" },
      ],
      folders: [],
    });
    let finished = false;
    const work = f.client
      .add("https://figma.com/files/folder/123", {
        cwd: f.cwd,
        directory: "root",
      })
      .finally(() => {
        finished = true;
      });
    try {
      await downloadStarted.promise;
      await discovered.promise;
      assert.equal(finished, false);
      assert.ok(calls.includes("B"));
      assert.ok(calls.includes("C"));
      const dir = path.join(f.cwd, "root");
      await assert.rejects(
        withManifest(dir, async () => {}),
        /locked/,
      );
      const m = await readManifest(dir);
      assert.equal(m.files.length, 3);
      assert.equal(m.files[0].synced, null);
    } finally {
      releaseDownload.release();
    }
    const result = await work;
    assert.deepEqual(result.errors, []);
    assert.equal(f.downloads.length, 3);
  },
);
test(
  "folder discovery advances across directories before download lane drains",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t, { concurrency: 1 });
    const started = pipelineGate(),
      release = pipelineGate(),
      childSeen = pipelineGate();
    f.listings.set("123", {
      name: "Root",
      files: [{ key: "A", name: "A" }],
      folders: [{ id: "456", name: "Child" }],
    });
    f.listings.set("456", {
      name: "Child",
      files: [{ key: "B", name: "B" }],
      folders: [],
    });
    const originalFolder = f.api.folder;
    f.api.folder = async (id) => {
      if (id === "456") childSeen.release();
      return originalFolder(id);
    };
    const originalDownload = f.downloader.download;
    f.downloader.download = async (key, target) => {
      if (key === "A") {
        started.release();
        await release.promise;
      }
      return originalDownload(key, target);
    };
    const work = f.client.add("https://figma.com/files/folder/123", {
      cwd: f.cwd,
      directory: "root",
    });
    try {
      await started.promise;
      await childSeen.promise;
      assert.equal(f.downloads.length, 0);
    } finally {
      release.release();
    }
    const result = await work;
    assert.deepEqual(result.errors, []);
    assert.equal(f.downloads.length, 2);
  },
);
test(
  "API concurrency limit is independent from the number of browser workers",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t, { concurrency: 1, apiConcurrency: 2 });
    let active = 0,
      maxActive = 0;
    const original = f.api.file;
    f.api.file = async (key) => {
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        return await original(key);
      } finally {
        active--;
      }
    };
    f.listings.set("123", {
      name: "Root",
      files: [
        { key: "A", name: "A" },
        { key: "B", name: "B" },
        { key: "C", name: "C" },
      ],
      folders: [],
    });
    const result = await f.client.add("https://figma.com/files/folder/123", {
      cwd: f.cwd,
      directory: "root",
    });
    assert.deepEqual(result.errors, []);
    assert.equal(maxActive, 2);
    assert.equal(f.downloads.length, 3);
  },
);
test(
  "later folder API failure drains earlier downloads and releases all locks",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    f.listings.set("123", {
      name: "Root",
      files: [{ key: "A", name: "A" }],
      folders: [{ id: "456", name: "Child" }],
    });
    f.listings.set("456", new Error("rate limited child"));
    const result = await f.client.add("https://figma.com/files/folder/123", {
      cwd: f.cwd,
      directory: "root",
    });
    assert.ok(result.errors.some((e) => e.includes("rate limited child")));
    assert.equal(f.downloads.length, 1);
    const dir = path.join(f.cwd, "root");
    assert.ok((await readManifest(dir)).files[0].synced);
    assert.ok(!(await readdir(dir)).includes(".sync.fig.lock"));
  },
);
test("fetch uses API concurrency without starting a browser or download queue", async (t) => {
  const f = await fixture(t, { apiConcurrency: 2 });
  await f.client.add("https://figma.com/design/A", { cwd: f.cwd });
  await f.client.add("https://figma.com/design/B", { cwd: f.cwd });
  const before = f.downloads.length;
  const result = await f.client.fetch({ cwd: f.cwd });
  assert.deepEqual(result.errors, []);
  assert.equal(f.downloads.length, before);
});

test(
  "bounded backlog pauses API look-ahead while download lane is blocked",
  { timeout: 10000 },
  async (t) => {
    const full = pipelineGate(),
      release = pipelineGate();
    const f = await fixture(t, {
      onProgress: (event) => {
        if (event.message.includes("Download queue full")) full.release();
      },
    });
    const files = Array.from({ length: 40 }, (_, i) => ({
      key: "K" + i,
      name: "File " + i,
    }));
    f.listings.set("123", { name: "Root", files, folders: [] });
    const original = f.downloader.download;
    f.downloader.download = async (...args) => {
      await release.promise;
      return original(...args);
    };
    let checked = 0;
    const originalApi = f.api.file;
    f.api.file = async (key) => {
      checked++;
      return originalApi(key);
    };
    const work = f.client.add("https://figma.com/files/folder/123", {
      cwd: f.cwd,
      directory: "root",
    });
    try {
      await full.promise;
      assert.ok(checked < 40);
      assert.equal(f.downloads.length, 0);
    } finally {
      release.release();
    }
    const result = await work;
    assert.deepEqual(result.errors, []);
    assert.equal(f.downloads.length, 40);
    assert.ok(
      (await readManifest(path.join(f.cwd, "root"))).files.every(
        (file) => file.synced,
      ),
    );
  },
);
test(
  "an API wait does not stop an already running browser transfer",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const browserStarted = pipelineGate(),
      releaseBrowser = pipelineGate(),
      apiWaiting = pipelineGate(),
      releaseApi = pipelineGate(),
      transferDone = pipelineGate();
    f.listings.set("123", {
      name: "Root",
      files: [
        { key: "A", name: "A" },
        { key: "B", name: "B" },
      ],
      folders: [],
    });
    const originalApi = f.api.file;
    f.api.file = async (key) => {
      if (key === "B") {
        await browserStarted.promise;
        apiWaiting.release();
        await releaseApi.promise;
      }
      return originalApi(key);
    };
    const originalDownload = f.downloader.download;
    f.downloader.download = async (key, target) => {
      if (key === "A") {
        browserStarted.release();
        await releaseBrowser.promise;
      }
      await originalDownload(key, target);
      if (key === "A") transferDone.release();
    };
    const work = f.client.add("https://figma.com/files/folder/123", {
      cwd: f.cwd,
      directory: "root",
    });
    try {
      await apiWaiting.promise;
      releaseBrowser.release();
      await transferDone.promise;
      assert.ok(f.downloads.includes("A"));
    } finally {
      releaseApi.release();
      releaseBrowser.release();
    }
    const result = await work;
    assert.deepEqual(result.errors, []);
    assert.equal(f.downloads.length, 2);
  },
);

test("ignore caches successful checks without extending their timestamp", async (t) => {
  const f = await fixture(t);
  await f.client.add("https://figma.com/design/A", { cwd: f.cwd });
  const before = (await readManifest(f.cwd)).files[0].remote
    .lastSuccessfulCheckedAt;
  let calls = 0;
  const original = f.api.file;
  f.api.file = async (key) => {
    calls++;
    return original(key);
  };
  await f.client.fetch({ cwd: f.cwd, ignore: "10m" });
  await f.client.sync({ cwd: f.cwd, ignore: "10m" });
  assert.equal(calls, 0);
  assert.equal(f.downloads.length, 1);
  assert.equal(
    (await readManifest(f.cwd)).files[0].remote.lastSuccessfulCheckedAt,
    before,
  );
});
test("pending version survives failure and a new client retries native download with cached discovery", async (t) => {
  const f = await fixture(t);
  await f.client.add("https://figma.com/design/A", { cwd: f.cwd });
  f.versions.set("A", { version: "2" });
  await f.client.fetch({ cwd: f.cwd });
  const timestamp = (await readManifest(f.cwd)).files[0].remote
    .lastSuccessfulCheckedAt;
  let calls = 0;
  const originalApi = f.api.file;
  f.api.file = async (key) => {
    calls++;
    return originalApi(key);
  };
  const originalDownload = f.downloader.download;
  f.downloader.download = async () => {
    const m = await readManifest(f.cwd);
    assert.equal(m.files[0].remote.version, "2");
    assert.equal(m.files[0].synced.version, "1");
    throw new Error("interrupted transfer");
  };
  const failed = await f.client.sync({ cwd: f.cwd, ignore: "10m" });
  assert.equal(failed.errors.length, 1);
  assert.equal(calls, 0);
  assert.equal(
    (await readManifest(f.cwd)).files[0].remote.lastSuccessfulCheckedAt,
    timestamp,
  );
  f.downloader.download = originalDownload;
  const retry = createFigmaSync({ api: f.api, downloader: f.downloader });
  try {
    const result = await retry.sync({ cwd: f.cwd, ignore: "10m" });
    assert.deepEqual(result.errors, []);
  } finally {
    await retry.close();
  }
  // Only the mandatory post-download validation goes to the API; cached discovery and precheck do not.
  assert.equal(calls, 1);
  assert.equal((await readManifest(f.cwd)).files[0].synced.version, "2");
});
test("ignore still downloads missing files and preserves remote-change safety", async (t) => {
  const f = await fixture(t);
  await f.client.add("https://figma.com/design/A", { cwd: f.cwd });
  const entry = (await readManifest(f.cwd)).files[0];
  await unlink(path.join(f.cwd, entry.localPath));
  const result = await f.client.sync({ cwd: f.cwd, ignore: "1m" });
  assert.deepEqual(result.errors, []);
  assert.equal(f.downloads.length, 2);
  f.versions.set("A", { version: "2" });
  await f.client.fetch({ cwd: f.cwd });
  const original = f.downloader.download;
  f.downloader.download = async (...args) => {
    await original(...args);
    f.versions.set("A", { version: "3" });
  };
  const changed = await f.client.sync({ cwd: f.cwd, ignore: "1m" });
  assert.equal(changed.errors.length, 1);
  assert.equal((await readManifest(f.cwd)).files[0].synced.version, "1");
  assert.equal((await readManifest(f.cwd)).files[0].remote.version, "3");
});
test("stale or future successful timestamps always refresh API metadata", async (t) => {
  const f = await fixture(t);
  await f.client.add("https://figma.com/design/A", { cwd: f.cwd });
  let calls = 0;
  const original = f.api.file;
  f.api.file = async (key) => {
    calls++;
    return original(key);
  };
  for (const date of [
    new Date(Date.now() - 120_000).toISOString(),
    new Date(Date.now() + 120_000).toISOString(),
  ]) {
    await withManifest(f.cwd, async (m) => {
      m.files[0].remote.lastSuccessfulCheckedAt = date;
    });
    await f.client.fetch({ cwd: f.cwd, ignore: "1m" });
  }
  assert.equal(calls, 2);
});
test("failed checks never advance last successful check or suppress retries", async (t) => {
  const f = await fixture(t);
  await f.client.add("https://figma.com/design/A", { cwd: f.cwd });
  const previous = (await readManifest(f.cwd)).files[0].remote
    .lastSuccessfulCheckedAt;
  f.versions.set("A", new FigmaApiError(404, "inaccessible"));
  await f.client.fetch({ cwd: f.cwd });
  assert.equal(
    (await readManifest(f.cwd)).files[0].remote.lastSuccessfulCheckedAt,
    previous,
  );
  let calls = 0;
  const original = f.api.file;
  f.api.file = async (key) => {
    calls++;
    return original(key);
  };
  await f.client.fetch({ cwd: f.cwd, ignore: "4h" });
  assert.equal(calls, 1);
  assert.equal(
    (await readManifest(f.cwd)).files[0].remote.lastSuccessfulCheckedAt,
    previous,
  );
});
test("folder cache retains successful subfolder discovery while pending files retry", async (t) => {
  const f = await fixture(t);
  f.listings.set("123", {
    name: "Root",
    files: [{ key: "A", name: "A" }],
    folders: [{ id: "456", name: "Child" }],
  });
  f.listings.set("456", { name: "Child", files: [], folders: [] });
  const native = f.downloader.download;
  f.downloader.download = async () => {
    throw new Error("offline");
  };
  await f.client.add("https://figma.com/files/folder/123", {
    cwd: f.cwd,
    directory: "root",
  });
  f.downloader.download = native;
  let folderCalls = 0;
  const original = f.api.folder;
  f.api.folder = async (id) => {
    folderCalls++;
    return original(id);
  };
  await f.client.add("https://figma.com/files/folder/123", {
    cwd: f.cwd,
    directory: "root",
    ignore: "4h",
  });
  assert.equal(folderCalls, 0);
  assert.equal(f.downloads.length, 1);
  assert.equal(
    (await readManifest(path.join(f.cwd, "root", "Child"))).folder.id,
    "456",
  );
});
test("listing timestamp alone cannot cache incomplete per-file metadata", async (t) => {
  const f = await fixture(t);
  f.listings.set("123", {
    name: "Root",
    files: [{ key: "A", name: "A" }],
    folders: [],
  });
  f.versions.set("A", new Error("metadata unavailable"));
  await f.client.add("https://figma.com/files/folder/123", {
    cwd: f.cwd,
    directory: "root",
  });
  const file = (await readManifest(path.join(f.cwd, "root"))).files[0];
  assert.equal(file.remote.lastSuccessfulCheckedAt, undefined);
  f.versions.set("A", { version: "1" });
  let calls = 0;
  const original = f.api.file;
  f.api.file = async (key) => {
    calls++;
    return original(key);
  };
  await f.client.fetch({ cwd: f.cwd, ignore: "4h" });
  assert.equal(calls, 1);
  assert.equal(f.downloads.length, 0);
});
test("legacy metadata without success marker is refreshed once", async (t) => {
  const f = await fixture(t);
  await f.client.add("https://figma.com/design/A", { cwd: f.cwd });
  await withManifest(f.cwd, async (m) => {
    delete m.files[0].remote.lastSuccessfulCheckedAt;
    delete m.files[0].remote.editorType;
  });
  let calls = 0;
  const original = f.api.file;
  f.api.file = async (key) => {
    calls++;
    return original(key);
  };
  await f.client.fetch({ cwd: f.cwd, ignore: "1m" });
  await f.client.fetch({ cwd: f.cwd, ignore: "1m" });
  assert.equal(calls, 1);
});

test("fresh remote check is durable before native download starts even when download fails", async (t) => {
  const f = await fixture(t);
  await f.client.add("https://figma.com/design/A", { cwd: f.cwd });
  f.versions.set("A", { version: "2" });
  f.downloader.download = async () => {
    const disk = await readManifest(f.cwd);
    assert.equal(disk.files[0].remote.version, "2");
    assert.ok(disk.files[0].remote.lastSuccessfulCheckedAt);
    assert.equal(disk.files[0].synced.version, "1");
    throw new Error("power loss simulation");
  };
  const result = await f.client.sync({ cwd: f.cwd });
  assert.equal(result.errors.length, 1);
  assert.equal((await readManifest(f.cwd)).files[0].remote.version, "2");
});
test("failed post-download validation never advances local sync baseline", async (t) => {
  const f = await fixture(t);
  await f.client.add("https://figma.com/design/A", { cwd: f.cwd });
  f.versions.set("A", { version: "2" });
  await f.client.fetch({ cwd: f.cwd });
  const native = f.downloader.download;
  f.downloader.download = async (...args) => {
    await native(...args);
    f.versions.set("A", new Error("API offline after transfer"));
  };
  const result = await f.client.sync({ cwd: f.cwd, ignore: "10m" });
  assert.equal(result.errors.length, 1);
  const m = await readManifest(f.cwd);
  assert.equal(m.files[0].synced.version, "1");
  assert.equal(m.files[0].remote.version, "2");
});
