import { acquireLock } from "./locks.js";
import { z } from "zod";
import { randomUUID, createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  open,
  readFile,
  lstat,
  mkdir,
  rename,
  unlink,
  readdir,
} from "node:fs/promises";
import path from "node:path";

export const MANIFEST_NAME = ".sync.fig.json";
const id = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const date = z.iso.datetime();
const url = z.url().refine((value) => {
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      ["figma.com", "www.figma.com"].includes(u.hostname) &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}, "Expected an HTTPS Figma URL");
const filename = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      !/[\\/\u0000-\u001f<>:"|?*]/.test(value) &&
      !/[. ]$/.test(value) &&
      value.endsWith(".fig") &&
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(value),
    "Expected a safe .fig filename, not a path",
  );
export const manifestSchema = z
  .looseObject({
    schemaVersion: z.literal(1),
    folder: z
      .looseObject({
        id,
        url,
        name: z.string(),
        lastFetchedAt: date.optional(),
        subfolders: z.array(z.object({ id, name: z.string() })).optional(),
      })
      .nullable(),
    files: z.array(
      z.looseObject({
        key: id,
        url,
        name: z.string(),
        localPath: filename,
        remote: z
          .looseObject({
            version: z.string().nullable(),
            modifiedAt: date.nullable(),
            checkedAt: date,
            lastSuccessfulCheckedAt: date.optional(),
            editorType: z.string().optional(),
            availability: z.enum(["available", "unavailable"]),
            membership: z.enum(["present", "absent"]).optional(),
          })
          .nullable(),
        synced: z
          .looseObject({
            version: z.string().nullable(),
            modifiedAt: date.nullable(),
            downloadedAt: date,
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            size: z.number().int().nonnegative(),
          })
          .nullable(),
      }),
    ),
  })
  .superRefine((m, ctx) => {
    const keys = new Set<string>();
    const paths = new Set<string>();
    for (const file of m.files) {
      const name = file.localPath.normalize("NFC").toLowerCase();
      if (keys.has(file.key) || paths.has(name))
        ctx.addIssue({
          code: "custom",
          message: "Duplicate file key or local filename",
        });
      keys.add(file.key);
      paths.add(name);
    }
  });
export type Manifest = z.infer<typeof manifestSchema>;
export type ManagedFile = Manifest["files"][number];
export const emptyManifest = (): Manifest => ({
  schemaVersion: 1,
  folder: null,
  files: [],
});
export function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
export async function assertRegular(file: string): Promise<boolean> {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("Refusing non-regular file: " + file);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}
export async function ensureDirectory(directory: string): Promise<void> {
  const absolute = path.resolve(directory);
  try {
    const s = await lstat(absolute);
    if (!s.isDirectory() || s.isSymbolicLink())
      throw new Error("Refusing non-directory or symbolic link: " + absolute);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    const parent = path.dirname(absolute);
    if (parent !== absolute) await ensureDirectory(parent);
    try {
      await mkdir(absolute);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      await ensureDirectory(absolute);
    }
  }
}
export async function ensureManifest(directory: string): Promise<Manifest> {
  await ensureDirectory(directory);
  const file = path.join(directory, MANIFEST_NAME);
  if (!(await assertRegular(file))) {
    try {
      await createExclusive(
        file,
        JSON.stringify(emptyManifest(), null, 2) + "\n",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return readManifest(directory);
}
/** Load an absent manifest in memory only; persist it when meaningful state is saved. */
export async function loadManifest(directory: string): Promise<Manifest> {
  return (await assertRegular(path.join(directory, MANIFEST_NAME)))
    ? readManifest(directory)
    : emptyManifest();
}
export async function readManifest(directory: string): Promise<Manifest> {
  const file = path.join(directory, MANIFEST_NAME);
  if (!(await assertRegular(file)))
    throw new Error("Manifest not found: " + file);
  try {
    return manifestSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch {
    throw new Error("Invalid or unsupported manifest; left untouched: " + file);
  }
}
export async function createExclusive(
  file: string,
  content: string,
): Promise<void> {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function atomicWrite(
  file: string,
  content: string,
  mode = 0o600,
): Promise<void> {
  const temp = file + ".tmp-" + randomUUID();
  const handle = await open(temp, "wx", mode);
  try {
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertRegular(file);
    await rename(temp, file);
  } finally {
    await unlink(temp).catch((e) => {
      if (!isNotFound(e)) throw e;
    });
  }
}
const manifestWrites = new Map<string, Promise<void>>();
export async function saveManifest(
  directory: string,
  manifest: Manifest,
): Promise<void> {
  manifestSchema.parse(manifest);
  const file = path.join(directory, MANIFEST_NAME);
  const content = JSON.stringify(manifest, null, 2) + "\n";
  const key = path.resolve(file);
  const previous = manifestWrites.get(key) ?? Promise.resolve();
  const write = previous
    .catch(() => {})
    .then(async () => {
      const exists = await assertRegular(file);
      if (!exists && !manifest.folder && manifest.files.length === 0) return;
      if (!exists || (await readFile(file, "utf8")) !== content)
        await atomicWrite(file, content);
    });
  manifestWrites.set(key, write);
  try {
    await write;
  } finally {
    if (manifestWrites.get(key) === write) manifestWrites.delete(key);
  }
}
/** Hold ownership while API production and download consumers share the same in-memory manifest. */
export async function acquireManifest(
  directory: string,
  recoverLocks = false,
): Promise<{ manifest: Manifest; release(): Promise<void> }> {
  await ensureDirectory(directory);
  const unlock = await acquireLock(directory, recoverLocks);
  try {
    const manifest = await loadManifest(directory);
    const before = JSON.stringify(manifest);
    let released = false;
    return {
      manifest,
      async release() {
        if (released) return;
        released = true;
        try {
          if (JSON.stringify(manifest) !== before)
            await saveManifest(directory, manifest);
        } finally {
          await unlock();
        }
      },
    };
  } catch (error) {
    await unlock();
    throw error;
  }
}
export async function withManifest<T>(
  directory: string,
  action: (manifest: Manifest) => Promise<T>,
  recoverLocks = false,
): Promise<T> {
  const lease = await acquireManifest(directory, recoverLocks);
  try {
    return await action(lease.manifest);
  } finally {
    await lease.release();
  }
}
export async function hashFile(
  file: string,
): Promise<{ sha256: string; size: number } | null> {
  if (!(await assertRegular(file))) return null;
  const handle = await open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false }))
      hash.update(chunk);
    return { sha256: hash.digest("hex"), size: stat.size };
  } finally {
    await handle.close();
  }
}
export function safeName(name: string): string {
  const cleaned = name
    .normalize("NFC")
    .replace(/[\\/\u0000-\u001f<>:"|?*]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 100);
  return !cleaned ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned) ||
    cleaned.startsWith(".")
    ? "Figma-" + (cleaned.replace(/^\.+/, "") || "file")
    : cleaned;
}
export async function allocateName(
  directory: string,
  name: string,
  key: string,
  reserved: string[],
  extension = ".fig",
): Promise<string> {
  const occupied = new Set(
    [...(await readdir(directory)), ...reserved].map((s) =>
      s.normalize("NFC").toLowerCase(),
    ),
  );
  const stem = safeName(name);
  let candidate = stem + extension;
  if (!occupied.has(candidate.toLowerCase())) return candidate;
  const suffix = createHash("sha256").update(key).digest("hex").slice(0, 10);
  candidate = stem + "--" + suffix + extension;
  for (let n = 2; occupied.has(candidate.toLowerCase()); n++)
    candidate = stem + "--" + suffix + "-" + n + extension;
  return candidate;
}
export async function discoverDirectories(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.some((e) => e.name === MANIFEST_NAME)) result.push(dir);
    for (const entry of entries)
      if (
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        !["node_modules", "dist", "coverage"].includes(entry.name)
      )
        await walk(path.join(dir, entry.name));
  }
  await walk(root);
  return result;
}
