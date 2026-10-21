import test from "node:test";
import assert from "node:assert/strict";
import {
  ResourcePool,
  forEachConcurrent,
  serialQueue,
  concurrencyLimit,
} from "../dist/concurrency.js";
import { PlaywrightDownloader } from "../dist/download.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
function gate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("resource pool bounds concurrent tabs and reuses idle tabs", async () => {
  let created = 0;
  let closed = 0;
  const wait = gate();
  const pool = new ResourcePool(
    async () => ++created,
    async () => {
      closed++;
    },
    2,
  );
  const first = pool.use(async () => {
    await wait.promise;
  });
  const second = pool.use(async () => {
    await wait.promise;
  });
  const third = pool.use(async () => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created, 2);
  wait.release();
  await Promise.all([first, second, third]);
  assert.equal(created, 2);
  await pool.use(async () => {});
  assert.equal(created, 2);
  await pool.close();
  assert.equal(closed, 2);
});
test("failed tab is discarded, replacement does not leak a pool slot", async () => {
  let created = 0;
  const discarded = [];
  const pool = new ResourcePool(
    async () => ++created,
    async (value) => {
      discarded.push(value);
    },
    1,
  );
  await assert.rejects(
    pool.use(async () => {
      throw new Error("broken");
    }),
  );
  await pool.use(async (tab) => {
    assert.equal(tab, 2);
  });
  assert.deepEqual(discarded, [1]);
  await pool.close();
  assert.deepEqual(discarded, [1, 2]);
});
test("workers respect maximum concurrency and wait for all before rejecting", async () => {
  const wait = gate();
  let started = 0;
  let settled = false;
  const job = forEachConcurrent([1, 2], 2, async (value) => {
    started++;
    if (value === 1) throw new Error("broken");
    await wait.promise;
  }).finally(() => {
    settled = true;
  });
  const rejection = assert.rejects(job, /broken/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 2);
  assert.equal(settled, false);
  wait.release();
  await rejection;
});
test("serial queue preserves order and recovers from rejection", async () => {
  const queue = serialQueue();
  const events = [];
  const wait = gate();
  const first = queue(async () => {
    events.push(1);
    await wait.promise;
    throw new Error("fail");
  });
  const rejected = assert.rejects(first);
  const second = queue(async () => {
    events.push(2);
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [1]);
  wait.release();
  await rejected;
  await second;
  assert.deepEqual(events, [1, 2]);
});
test("limits reject invalid values", () => {
  for (const n of [0, -1, 4, 1.5, NaN])
    assert.throws(() => concurrencyLimit(n));
});

test("parallel native downloads initialize one browser/context and reuse tabs", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "figma-browser-pool-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let tick = Date.now();
  t.mock.method(Date, "now", () => {
    tick += 20_000;
    return tick;
  });
  let launched = 0,
    contexts = 0,
    pages = 0,
    closed = 0,
    saves = 0;
  const pending = [];
  const context = {
    async newPage() {
      pages++;
      let url = "about:blank";
      const download = {
        suggestedFilename: () => "document.fig",
        async saveAs(destination) {
          await writeFile(destination, "fig-kiwi mock");
        },
        async failure() {
          return null;
        },
      };
      return {
        url: () => url,
        setDefaultTimeout() {},
        async goto(value) {
          assert.notEqual(
            value,
            "about:blank",
            "Do not unload Figma between downloads",
          );
          url = value;
        },
        getByRole() {
          return { async click() {} };
        },
        locator() {
          return {
            async click() {},
            first() {
              return {
                async count() {
                  return 0;
                },
              };
            },
          };
        },
        getByText() {
          return { async click() {} };
        },
        async waitForEvent() {
          const wait = gate();
          pending.push(wait);
          if (pending.length >= 2) {
            for (const item of pending) item.release();
          }
          await wait.promise;
          return download;
        },
        async close() {},
      };
    },
  };
  const browser = {
    async newContext() {
      contexts++;
      return context;
    },
    async close() {
      closed++;
    },
  };
  const auth = {
    sessionPath: "unused",
    async hasSession() {
      return true;
    },
    async saveSession() {
      saves++;
    },
  };
  const downloader = new PlaywrightDownloader(
    auth,
    { concurrency: 2 },
    {
      async launch() {
        launched++;
        await new Promise((resolve) => setImmediate(resolve));
        return browser;
      },
    },
  );
  try {
    await Promise.all([
      downloader.download("A", path.join(dir, "A.fig")),
      downloader.download("B", path.join(dir, "B.fig")),
    ]);
    assert.equal(launched, 1);
    assert.equal(contexts, 1);
    assert.equal(pages, 2);
    assert.equal(closed, 0);
    assert.equal(saves, 2);
    // A subsequent operation leases a previously used tab instead of opening a third.
    await downloader.download("C", path.join(dir, "C.fig"));
    assert.equal(pages, 2);
    assert.equal(launched, 1);
  } finally {
    await downloader.close();
  }
  assert.equal(closed, 1);
});
test("failed initialization closes partial browser and permits clean retry", async () => {
  let launches = 0,
    closes = 0;
  const downloader = new PlaywrightDownloader(
    {
      async hasSession() {
        return true;
      },
      sessionPath: "unused",
    },
    {},
    {
      async launch() {
        launches++;
        return {
          async newContext() {
            throw new Error("bad session");
          },
          async close() {
            closes++;
          },
        };
      },
    },
  );
  await assert.rejects(downloader.download("A", "unused"), /bad session/);
  await assert.rejects(downloader.download("B", "unused"), /bad session/);
  assert.equal(launches, 2);
  assert.equal(closes, 2);
  await downloader.close();
});
