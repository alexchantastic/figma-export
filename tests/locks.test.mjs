import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  acquireLock,
  inspectLock,
  clearLock,
  listLocks,
} from "../dist/locks.js";
import { acquireManifest } from "../dist/manifest.js";
const deadPid = Number(
  spawnSync(process.execPath, ["-e", "console.log(process.pid)"], {
    encoding: "utf8",
  }).stdout.trim(),
);
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "figma-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test("owned lock exposes PID/host and releases only its own generation", async (t) => {
  const dir = await fixture(t);
  const release = await acquireLock(dir);
  const info = await inspectLock(dir);
  assert.equal(info.state, "active");
  assert.equal(info.pid, process.pid);
  assert.equal(info.host, hostname());
  await release();
  assert.equal(await inspectLock(dir), null);
});
test("live local locks cannot be cleared or recovered even with force", async (t) => {
  const dir = await fixture(t);
  const release = await acquireLock(dir);
  await assert.rejects(clearLock(dir, true), /active/);
  await assert.rejects(acquireLock(dir, true), /locked/);
  await release();
});
test("proven stale same-host lock recovers only when explicitly requested", async (t) => {
  const dir = await fixture(t);
  await writeFile(
    path.join(dir, ".sync.fig.lock"),
    JSON.stringify({ pid: deadPid, host: hostname() }),
  );
  assert.equal((await inspectLock(dir)).state, "stale");
  await assert.rejects(acquireLock(dir), /locked/);
  const release = await acquireLock(dir, true);
  assert.equal((await inspectLock(dir)).state, "active");
  await release();
});
test("legacy foreign and malformed locks require explicit unknown recovery", async (t) => {
  const dir = await fixture(t);
  for (const content of [
    "bad",
    JSON.stringify({ pid: deadPid }),
    JSON.stringify({ pid: deadPid, host: "another-host" }),
  ]) {
    await writeFile(path.join(dir, ".sync.fig.lock"), content);
    assert.equal((await inspectLock(dir)).state, "unknown");
    await assert.rejects(clearLock(dir), /unknown/);
    await assert.rejects(acquireLock(dir, true), /locked/);
    assert.equal(await clearLock(dir, true), true);
  }
});
test("a lock owner never removes a replacement lock", async (t) => {
  const dir = await fixture(t);
  const release = await acquireLock(dir);
  const lock = path.join(dir, ".sync.fig.lock");
  await writeFile(lock, "replacement");
  await assert.rejects(release(), /changed/);
  assert.equal(await readFile(lock, "utf8"), "replacement");
});
test("lock listing is read-only and recursive", async (t) => {
  const dir = await fixture(t);
  const lease = await acquireManifest(path.join(dir, "child"));
  const found = await listLocks(dir);
  assert.equal(found.length, 1);
  assert.equal(found[0].state, "active");
  assert.equal((await listLocks(dir, false)).length, 0);
  await lease.release();
  assert.deepEqual(await readdir(path.join(dir, "child")), []);
});
test("lock commands refuse symbolic links", async (t) => {
  const dir = await fixture(t);
  const file = path.join(dir, "private");
  await writeFile(file, "keep");
  await symlink(file, path.join(dir, ".sync.fig.lock"));
  await assert.rejects(inspectLock(dir), /unsafe/);
  await assert.rejects(clearLock(dir, true), /unsafe/);
  assert.equal(await readFile(file, "utf8"), "keep");
});
test("release removes lock even when final manifest write fails", async (t) => {
  const dir = await fixture(t);
  const lease = await acquireManifest(dir);
  lease.manifest.schemaVersion = 99;
  await assert.rejects(lease.release());
  assert.equal(await inspectLock(dir), null);
});
for (const event of [
  "SIGINT",
  "SIGTERM",
  "uncaughtException",
  "unhandledRejection",
]) {
  test(
    "shutdown " + event + " aborts pipeline and removes owned locks",
    { timeout: 10000 },
    async (t) => {
      const dir = await fixture(t);
      const syncUrl = new URL("../dist/index.js", import.meta.url).href;
      const shutdownUrl = new URL("../dist/shutdown.js", import.meta.url).href;
      const script = `import {createFigmaSync} from ${JSON.stringify(syncUrl)};import {installShutdown} from ${JSON.stringify(shutdownUrl)};
const controller=new AbortController();const stop=installShutdown(controller,()=>{});const timer=setInterval(()=>{},100);
const api={async file(key){return {key,name:"A",version:"1",modifiedAt:"2026-01-01T00:00:00Z",editorType:"figma"};},async folder(){throw Error("unused");},async validateToken(){}};
const downloader={async download(){process.stdout.write("READY"+String.fromCharCode(10));if(${JSON.stringify(event)}.startsWith("SIG"))process.emit(${JSON.stringify(event)});else process.emit(${JSON.stringify(event)},new Error("fatal test"));await new Promise((resolve,reject)=>{if(controller.signal.aborted)reject(controller.signal.reason);else controller.signal.addEventListener("abort",()=>reject(controller.signal.reason),{once:true});});},async close(){}};
const client=createFigmaSync({api,downloader,signal:controller.signal});try{await client.add("https://figma.com/design/A",{cwd:process.cwd()});}catch{}finally{await client.close();stop();clearInterval(timer);}`;
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", script],
        { cwd: dir, encoding: "utf8", timeout: 8000 },
      );
      assert.match(result.stdout, /READY/);
      assert.equal(
        result.status,
        event === "SIGINT" ? 130 : event === "SIGTERM" ? 143 : 1,
        result.stderr,
      );
      assert.equal(await inspectLock(dir), null);
      const m = JSON.parse(
        await readFile(path.join(dir, ".sync.fig.json"), "utf8"),
      );
      assert.equal(m.files[0].synced, null);
      assert.ok(m.files[0].remote.lastSuccessfulCheckedAt);
    },
  );
}

test("legacy lock error names the exact file and quoted recovery command", async (t) => {
  const root = await fixture(t);
  const directory = path.join(root, "Alta Fidelidade");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(directory);
  await writeFile(
    path.join(directory, ".sync.fig.lock"),
    JSON.stringify({ pid: deadPid }),
  );
  await assert.rejects(acquireLock(directory, true), (error) => {
    assert.ok(
      error.message.includes(
        "Lock file: " + path.join(directory, ".sync.fig.lock"),
      ),
    );
    assert.ok(error.message.includes("Owner: PID " + deadPid));
    assert.ok(error.message.includes("figma-files-sync locks list "));
    assert.ok(error.message.includes("figma-files-sync locks clear "));
    assert.ok(error.message.includes("--force"));
    return true;
  });
});
test("live lock error identifies owner and never suggests forcing removal", async (t) => {
  const dir = await fixture(t);
  const release = await acquireLock(dir);
  try {
    await assert.rejects(acquireLock(dir), (error) => {
      assert.ok(error.message.includes(path.join(dir, ".sync.fig.lock")));
      assert.ok(error.message.includes("PID " + process.pid));
      assert.ok(error.message.includes("Stop the owner first"));
      assert.ok(!error.message.includes("--force"));
      return true;
    });
  } finally {
    await release();
  }
});
test("stale lock error includes an exact safe clear command", async (t) => {
  const dir = await fixture(t);
  await writeFile(
    path.join(dir, ".sync.fig.lock"),
    JSON.stringify({ pid: deadPid, host: hostname() }),
  );
  await assert.rejects(acquireLock(dir), (error) => {
    assert.ok(
      error.message.includes("Lock file: " + path.join(dir, ".sync.fig.lock")),
    );
    assert.ok(error.message.includes("Recover: figma-files-sync locks clear "));
    assert.ok(error.message.includes("--recover-locks"));
    assert.ok(!error.message.includes("--force"));
    return true;
  });
});
