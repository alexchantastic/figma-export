import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { open, lstat, readFile, unlink, readdir } from "node:fs/promises";
import path from "node:path";

export const LOCK_NAME = ".sync.fig.lock";
export interface LockInfo {
  directory: string;
  path: string;
  pid?: number;
  host?: string;
  startedAt?: string;
  state: "active" | "stale" | "unknown";
  reason: string;
}
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
async function snapshot(file: string) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Refusing unsafe lock: " + file);
  return { stat, text: await readFile(file, "utf8") };
}
function classify(directory: string, text: string): LockInfo {
  const base = { directory, path: path.join(directory, LOCK_NAME) };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ...base, state: "unknown", reason: "Malformed lock" };
  }
  const pid = data?.pid;
  const host = typeof data?.host === "string" ? data.host : undefined;
  const info = {
    ...base,
    ...(Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
    host,
    startedAt: typeof data?.startedAt === "string" ? data.startedAt : undefined,
  };
  if (host && host !== hostname())
    return {
      ...info,
      state: "unknown",
      reason: "Owned by another host; local PID cannot prove liveness",
    };
  if (!info.pid)
    return { ...info, state: "unknown", reason: "Missing valid process ID" };
  try {
    process.kill(info.pid, 0);
    return {
      ...info,
      state: "active",
      reason: "PID is alive (may have been reused); never bypass automatically",
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH")
      return {
        ...info,
        state: "unknown",
        reason: "Cannot prove process has exited",
      };
    if (!host)
      return {
        ...info,
        state: "unknown",
        reason: "Legacy lock has no hostname; verify its owner manually",
      };
    return {
      ...info,
      state: "stale",
      reason: "Same-host process no longer exists",
    };
  }
}
export async function inspectLock(directory: string): Promise<LockInfo | null> {
  try {
    return classify(
      path.resolve(directory),
      (await snapshot(path.join(directory, LOCK_NAME))).text,
    );
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
}
async function removeSnapshot(
  file: string,
  original: Awaited<ReturnType<typeof snapshot>>,
): Promise<boolean> {
  try {
    const now = await snapshot(file);
    if (
      now.text !== original.text ||
      now.stat.ino !== original.stat.ino ||
      now.stat.dev !== original.stat.dev
    )
      throw new Error(
        "Lock changed during recovery; retry after inspecting it: " + file,
      );
    await unlink(file);
    return true;
  } catch (e) {
    if (missing(e)) return false;
    throw e;
  }
}
export async function clearLock(
  directory: string,
  forceUnknown = false,
): Promise<boolean> {
  const file = path.join(directory, LOCK_NAME);
  let original;
  try {
    original = await snapshot(file);
  } catch (e) {
    if (missing(e)) return false;
    throw e;
  }
  const info = classify(path.resolve(directory), original.text);
  if (info.state === "active" || (info.state === "unknown" && !forceUnknown))
    throw new Error(
      "Refusing to clear " + info.state + " lock: " + file + ". " + info.reason,
    );
  return removeSnapshot(file, original);
}
function commandArgument(value: string): string {
  return process.platform === "win32"
    ? JSON.stringify(value)
    : "'" + value.replaceAll("'", "'\\''") + "'";
}
function lockRecoveryHelp(directory: string, info: LockInfo | null): string {
  const argument = commandArgument(directory);
  const details =
    "\nLock file: " +
    path.join(directory, LOCK_NAME) +
    "\nOwner: PID " +
    (info?.pid ?? "unknown") +
    ", host " +
    (info?.host ?? "unknown") +
    (info?.startedAt ? ", started " + info.startedAt : "") +
    "\nInspect: figma-files-sync locks list " +
    argument +
    " --no-recursive";
  if (info?.state === "active")
    return (
      details +
      "\nDo not remove this lock while its process is active. Stop the owner first."
    );
  if (info?.state === "stale")
    return (
      details +
      "\nRecover: figma-files-sync locks clear " +
      argument +
      "\nOr rerun sync with --recover-locks."
    );
  return (
    details +
    "\nAutomatic recovery is unsafe: this lock is legacy, malformed or cannot be verified locally." +
    "\nAfter confirming the owner is no longer running: figma-files-sync locks clear " +
    argument +
    " --force"
  );
}
export async function acquireLock(
  directory: string,
  recover = false,
): Promise<() => Promise<void>> {
  const file = path.join(directory, LOCK_NAME);
  const text = JSON.stringify({
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    owner: randomUUID(),
  });
  for (let attempt = 0; ; attempt++) {
    try {
      const handle = await open(file, "wx", 0o600);
      try {
        await handle.writeFile(text);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const own = await snapshot(file);
      if (own.text !== text) throw new Error("Lock ownership changed: " + file);
      return async () => {
        await removeSnapshot(file, own);
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const info = await inspectLock(directory);
      if (recover && attempt === 0 && info?.state === "stale") {
        await clearLock(directory);
        continue;
      }
      throw new Error(
        "Directory is locked: " +
          directory +
          ". " +
          (info?.reason ?? "Lock changed") +
          lockRecoveryHelp(path.resolve(directory), info),
      );
    }
  }
}
export async function listLocks(
  root: string,
  recursive = true,
): Promise<LockInfo[]> {
  const result: LockInfo[] = [];
  async function walk(directory: string) {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Refusing unsafe lock search directory: " + directory);
    const lock = await inspectLock(directory);
    if (lock) result.push(lock);
    if (recursive)
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (
          entry.isDirectory() &&
          !entry.name.startsWith(".") &&
          !["node_modules", "dist", "coverage"].includes(entry.name)
        )
          await walk(path.join(directory, entry.name));
      }
  }
  await walk(path.resolve(root));
  return result;
}
