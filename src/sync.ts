import { parseDuration, isFresh } from "./freshness.js";
import {
  concurrencyLimit,
  forEachConcurrent,
  TaskQueue,
} from "./concurrency.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { copyFile, rename, unlink, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import {
  type FigmaApi,
  RestFigmaApi,
  FigmaApiError,
  parseFigmaUrl,
  type FileMetadata,
} from "./api.js";
import { AuthStore } from "./auth.js";
import {
  PlaywrightDownloader,
  verifyNativeFile,
  type NativeDownloader,
  type DownloadOptions,
} from "./download.js";
import {
  type Manifest,
  type ManagedFile,
  withManifest,
  acquireManifest,
  loadManifest,
  readManifest,
  saveManifest,
  allocateName,
  hashFile,
  assertRegular,
  discoverDirectories,
  isNotFound,
  ensureDirectory,
} from "./manifest.js";

export type FileStatus =
  | "new"
  | "missing"
  | "modified"
  | "unchanged"
  | "conflict"
  | "unavailable"
  | "unsupported"
  | "downloaded"
  | "error";
export interface SyncItem {
  directory: string;
  key: string;
  localPath: string;
  status: FileStatus;
  message?: string;
}
export interface SyncResult {
  items: SyncItem[];
  errors: string[];
}
export interface RunOptions {
  cwd?: string;
  recursive?: boolean;
  force?: boolean;
  /** Skip fresh discovery/metadata checks, not pending downloads (e.g. 10m). */
  ignore?: string;
  recoverLocks?: boolean;
}
export interface ClientOptions extends DownloadOptions {
  token?: string;
  authDirectory?: string;
  api?: FigmaApi;
  downloader?: NativeDownloader;
  onEvent?: (item: SyncItem) => void;
  /** Maximum concurrent API operations, independent from browser tabs (1–3). */
  apiConcurrency?: number;
  recoverLocks?: boolean;
  ignore?: string;
}
export function planFile(
  file: ManagedFile,
  local: { sha256: string } | null,
): FileStatus {
  if (file.remote?.availability !== "available") return "unavailable";
  if (local && (!file.synced || local.sha256 !== file.synced.sha256))
    return "conflict";
  if (!local) return file.synced ? "missing" : "new";
  if (!file.synced) return "new";
  if (file.remote.version !== null && file.synced.version !== null)
    return file.remote.version === file.synced.version
      ? "unchanged"
      : "modified";
  return file.remote.modifiedAt &&
    file.synced.modifiedAt === file.remote.modifiedAt
    ? "unchanged"
    : "modified";
}
export class FigmaSync {
  private readonly auth: AuthStore;
  private apiInstance?: FigmaApi;
  private readonly apiQueue: TaskQueue;
  private readonly downloader: NativeDownloader;
  constructor(private readonly options: ClientOptions = {}) {
    concurrencyLimit(options.concurrency);
    parseDuration(options.ignore);
    this.apiQueue = new TaskQueue(concurrencyLimit(options.apiConcurrency));
    this.auth = new AuthStore(options.authDirectory);
    if (options.api) this.apiInstance = this.scheduleApi(options.api);
    this.downloader =
      options.downloader ?? new PlaywrightDownloader(this.auth, options);
  }
  private async api(): Promise<FigmaApi> {
    this.options.onProgress?.({
      phase: "auth",
      message: "Loading Figma API credentials",
    });
    return (this.apiInstance ??= this.scheduleApi(
      new RestFigmaApi(
        this.options.token ?? (await this.auth.token()) ?? "",
        undefined,
        this.options.onProgress,
        this.options.signal,
      ),
    ));
  }
  private scheduleApi(api: FigmaApi): FigmaApi {
    return {
      file: (key) =>
        this.apiQueue.run(() => {
          this.options.signal?.throwIfAborted();
          return api.file(key);
        }),
      folder: (id) =>
        this.apiQueue.run(() => {
          this.options.signal?.throwIfAborted();
          return api.folder(id);
        }),
      validateToken: () => this.apiQueue.run(() => api.validateToken()),
    };
  }
  async close(): Promise<void> {
    await this.downloader.close();
  }
  async add(
    url: string,
    options: RunOptions & { directory?: string } = {},
  ): Promise<SyncResult> {
    this.options.signal?.throwIfAborted();
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const ignoreMs = parseDuration(options.ignore ?? this.options.ignore);
    const ref = parseFigmaUrl(url);
    const api = await this.api();
    if (ref.kind === "file") {
      let directory = path.resolve(cwd, options.directory ?? ".");
      if (!options.directory) {
        for (const candidate of await discoverDirectories(cwd)) {
          if (
            (await readManifest(candidate)).files.some(
              (file) => file.key === ref.id,
            )
          ) {
            directory = candidate;
            break;
          }
        }
      }
      await withManifest(
        directory,
        async (manifest) => {
          if (manifest.files.some((f) => f.key === ref.id)) return;
          const meta = await api.file(ref.id);
          if (meta.editorType !== "figma")
            throw new Error("Only Figma Design .fig documents are supported.");
          const localPath = await allocateName(
            directory,
            meta.name,
            meta.key,
            manifest.files.map((f) => f.localPath),
          );
          manifest.files.push({
            key: ref.id,
            url: ref.url,
            name: meta.name,
            localPath,
            remote: this.remote(meta),
            synced: null,
          });
        },
        options.recoverLocks ?? this.options.recoverLocks,
      );
      return this.run(
        { ...options, cwd: directory, recursive: false },
        true,
        ref.id,
      );
    }
    const existingDirectory = options.directory
      ? path.resolve(cwd, options.directory)
      : await this.findFolder(cwd, ref.id);
    if (existingDirectory) {
      const existing = await loadManifest(existingDirectory);
      if (
        existing.folder?.id === ref.id &&
        existing.folder.subfolders &&
        isFresh(existing.folder.lastFetchedAt, ignoreMs)
      ) {
        return this.run(
          { ...options, cwd: existingDirectory, recursive: true },
          true,
        );
      }
    }
    this.options.onProgress?.({
      phase: "discovery",
      message: "Listing Figma folder " + ref.id,
    });
    const listing = await api.folder(ref.id);
    this.options.onProgress?.({
      phase: "discovery",
      message:
        "Found " +
        listing.files.length +
        " files and " +
        listing.folders.length +
        " subfolders in " +
        listing.name,
    });
    let directory: string;
    if (options.directory) directory = path.resolve(cwd, options.directory);
    else {
      const existing = await this.findFolder(cwd, ref.id);
      directory =
        existing ??
        path.join(cwd, await allocateName(cwd, listing.name, ref.id, [], ""));
    }
    await withManifest(
      directory,
      async (manifest) => {
        if (manifest.folder && manifest.folder.id !== ref.id)
          throw new Error(
            "Directory is already associated with another Figma folder.",
          );
        manifest.folder ??= { id: ref.id, url: ref.url, name: listing.name };
      },
      options.recoverLocks ?? this.options.recoverLocks,
    );
    return this.run({ ...options, cwd: directory, recursive: true }, true);
  }
  async fetch(options: RunOptions = {}): Promise<SyncResult> {
    return this.run(options, false);
  }
  async sync(options: RunOptions = {}): Promise<SyncResult> {
    return this.run(options, true);
  }
  private remote(meta: FileMetadata): NonNullable<ManagedFile["remote"]> {
    return {
      version: meta.version,
      modifiedAt: meta.modifiedAt,
      checkedAt: new Date().toISOString(),
      lastSuccessfulCheckedAt: new Date().toISOString(),
      editorType: meta.editorType,
      availability: "available",
    };
  }
  private cachedMetadata(
    file: ManagedFile,
    ignoreMs: number,
  ): FileMetadata | undefined {
    const remote = file.remote;
    if (
      remote?.availability !== "available" ||
      !remote.version ||
      !remote.editorType ||
      !isFresh(remote.lastSuccessfulCheckedAt, ignoreMs)
    )
      return;
    return {
      key: file.key,
      name: file.name,
      version: remote.version,
      modifiedAt: remote.modifiedAt,
      editorType: remote.editorType,
    };
  }
  private async findFolder(
    parent: string,
    id: string,
  ): Promise<string | undefined> {
    if ((await loadManifest(parent)).folder?.id === id) return parent;
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        entry.name.startsWith(".") ||
        entry.name === "node_modules"
      )
        continue;
      const dir = path.join(parent, entry.name);
      if (
        (await assertRegular(path.join(dir, ".sync.fig.json"))) &&
        (await readManifest(dir)).folder?.id === id
      )
        return dir;
    }
    return undefined;
  }
  private async run(
    options: RunOptions,
    download: boolean,
    onlyKey?: string,
  ): Promise<SyncResult> {
    const ignoreMs = parseDuration(options.ignore ?? this.options.ignore);
    this.options.signal?.throwIfAborted();
    const root = path.resolve(options.cwd ?? process.cwd());
    this.options.onProgress?.({
      phase: "manifest",
      message: "Reading manifests in " + root,
    });
    const api = await this.api();
    const result: SyncResult = { items: [], errors: [] };
    const directories =
      options.recursive === false
        ? (await assertRegular(path.join(root, ".sync.fig.json")))
          ? [root]
          : []
        : await discoverDirectories(root);
    const known = new Map<string, string>();
    for (const directory of directories)
      for (const file of (await readManifest(directory)).files) {
        if (!known.has(file.key)) known.set(file.key, directory);
      }
    const leases: Awaited<ReturnType<typeof acquireManifest>>[] = [];
    const downloads = new TaskQueue(concurrencyLimit(this.options.concurrency));
    const pending = new Set<Promise<void>>();
    // Bound discovery look-ahead; in-flight metadata producers can exceed this high-water mark by at most their concurrency.
    const maxPending = 32;
    const enqueue = async (action: () => Promise<void>) => {
      this.options.signal?.throwIfAborted();
      while (pending.size >= maxPending) {
        this.options.signal?.throwIfAborted();
        this.options.onProgress?.({
          phase: "download",
          message:
            "Download queue full (" + pending.size + "); waiting for capacity",
        });
        await Promise.race(pending);
      }
      const job = downloads
        .run(() => {
          this.options.signal?.throwIfAborted();
          return action();
        })
        .catch((error) => {
          result.errors.push(
            error instanceof Error ? error.message : "Download worker failed",
          );
        });
      pending.add(job);
      void job.then(() => pending.delete(job));
      this.options.onProgress?.({
        phase: "download",
        message:
          "Download queue: " +
          downloads.running +
          " active, " +
          downloads.waiting +
          " waiting; API discovery continues",
      });
    };
    const visited = new Set<string>();
    const folderIds = new Map<string, string>();
    const emit = (item: SyncItem) => {
      result.items.push(item);
      this.options.onEvent?.(item);
    };
    const visit = async (directory: string): Promise<void> => {
      this.options.signal?.throwIfAborted();
      if (visited.has(directory)) return;
      visited.add(directory);
      const children: { id: string; name: string }[] = [];
      try {
        this.options.onProgress?.({
          phase: "manifest",
          message: "Processing directory " + directory,
        });
        const lease = await acquireManifest(
          directory,
          options.recoverLocks ?? this.options.recoverLocks,
        );
        leases.push(lease);
        const manifest = lease.manifest;
        {
          if (manifest.folder) {
            const folder = manifest.folder;
            const prior = folderIds.get(folder.id);
            if (prior && prior !== directory)
              throw new Error(
                "Duplicate folder registration in this sync tree: " + folder.id,
              );
            folderIds.set(folder.id, directory);
            if (folder.subfolders && isFresh(folder.lastFetchedAt, ignoreMs)) {
              children.push(...folder.subfolders);
              this.options.onProgress?.({
                phase: "discovery",
                message:
                  "Reusing successful folder listing from " +
                  folder.lastFetchedAt +
                  ": " +
                  folder.name,
              });
            } else {
              this.options.onProgress?.({
                phase: "discovery",
                message: "Listing remote folder " + folder.id,
              });
              const listing = await api.folder(folder.id);
              this.options.onProgress?.({
                phase: "discovery",
                message:
                  "Found " +
                  listing.files.length +
                  " files and " +
                  listing.folders.length +
                  " subfolders in " +
                  listing.name,
              });
              folder.name = listing.name;

              children.push(...listing.folders);
              const present = new Set(listing.files.map((f) => f.key));
              for (const file of manifest.files)
                if (file.remote)
                  file.remote.membership = present.has(file.key)
                    ? "present"
                    : "absent";
              for (const remoteFile of listing.files) {
                if (manifest.files.some((f) => f.key === remoteFile.key))
                  continue;
                // Keep a document's established local location when it moves remotely.
                if (
                  known.has(remoteFile.key) &&
                  known.get(remoteFile.key) !== directory
                )
                  continue;
                const localPath = await allocateName(
                  directory,
                  remoteFile.name,
                  remoteFile.key,
                  manifest.files.map((f) => f.localPath),
                );
                manifest.files.push({
                  key: remoteFile.key,
                  name: remoteFile.name,
                  url: "https://www.figma.com/design/" + remoteFile.key,
                  localPath,
                  remote: {
                    version: null,
                    modifiedAt: null,
                    checkedAt: new Date().toISOString(),
                    availability: "available",
                    membership: "present",
                  },
                  synced: null,
                });
                known.set(remoteFile.key, directory);
              }
              folder.subfolders = listing.folders;
              folder.lastFetchedAt = new Date().toISOString();
              await saveManifest(directory, manifest);
            }
          }
          const selectedFiles = manifest.files.filter(
            (file) => !onlyKey || file.key === onlyKey,
          );
          await forEachConcurrent(
            selectedFiles,
            concurrencyLimit(this.options.apiConcurrency),
            async (file, index) => {
              this.options.signal?.throwIfAborted();
              const fileIndex = index + 1;
              this.options.onProgress?.({
                phase: "file",
                message:
                  "Checking file " +
                  fileIndex +
                  "/" +
                  selectedFiles.length +
                  " in " +
                  directory +
                  ": " +
                  file.localPath,
              });
              if (onlyKey && file.key !== onlyKey) return;
              const item = {
                directory,
                key: file.key,
                localPath: file.localPath,
              };
              try {
                let meta: FileMetadata;
                const cached = this.cachedMetadata(file, ignoreMs);
                try {
                  if (cached)
                    this.options.onProgress?.({
                      phase: "api",
                      message:
                        "Skipping recent API check for " +
                        file.localPath +
                        " (last success " +
                        file.remote!.lastSuccessfulCheckedAt +
                        ")",
                    });
                  meta = cached ?? (await api.file(file.key));
                } catch (error) {
                  if (
                    error instanceof FigmaApiError &&
                    [403, 404].includes(error.status)
                  ) {
                    file.remote = {
                      ...file.remote,
                      version: file.remote?.version ?? null,
                      modifiedAt: file.remote?.modifiedAt ?? null,
                      checkedAt: new Date().toISOString(),
                      availability: "unavailable",
                      ...(file.remote?.membership
                        ? { membership: file.remote.membership }
                        : {}),
                    };
                    emit({
                      ...item,
                      status: "unavailable",
                      message: error.message,
                    });
                    return;
                  }
                  throw error;
                }
                const membership = file.remote?.membership;
                if (!cached)
                  file.remote = {
                    ...file.remote,
                    ...this.remote(meta),
                    ...(membership ? { membership } : {}),
                  };
                file.name = meta.name;
                // Checkpoint remote state immediately, before hashing/enqueueing or starting native work.
                await saveManifest(directory, manifest);
                if (meta.editorType !== "figma") {
                  emit({
                    ...item,
                    status: "unsupported",
                    message: "Only Figma Design is supported.",
                  });
                  return;
                }
                const target = path.join(directory, file.localPath);
                const local = await hashFile(target);
                const status = planFile(file, local);
                if (
                  !download ||
                  status === "unchanged" ||
                  status === "unavailable" ||
                  (status === "conflict" && !options.force)
                ) {
                  emit({ ...item, status });
                  return;
                }
                await saveManifest(directory, manifest);
                await enqueue(async () => {
                  try {
                    this.options.onProgress?.({
                      phase: "download",
                      message:
                        "Downloading file " +
                        fileIndex +
                        "/" +
                        selectedFiles.length +
                        " in " +
                        directory +
                        ": " +
                        file.localPath +
                        " (" +
                        status +
                        ")",
                    });
                    await this.downloadFile(
                      api,
                      directory,
                      manifest,
                      file,
                      local,
                      !!options.force,
                      ignoreMs,
                    );
                    emit({ ...item, status: "downloaded" });
                  } catch (error) {
                    const message =
                      error instanceof Error
                        ? error.message
                        : "Download failed";
                    result.errors.push(file.key + ": " + message);
                    emit({ ...item, status: "error", message });
                  } finally {
                    await saveManifest(directory, manifest);
                  }
                });
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : "Operation failed";
                result.errors.push(file.key + ": " + message);
                emit({ ...item, status: "error", message });
              } finally {
                await saveManifest(directory, manifest);
              }
            },
          );
        }
      } catch (error) {
        result.errors.push(
          directory +
            ": " +
            (error instanceof Error ? error.message : "Operation failed"),
        );
      }
      if (options.recursive !== false)
        for (const child of children) {
          if (folderIds.has(child.id)) continue;
          try {
            let dir = await this.findFolder(directory, child.id);
            if (!dir) {
              dir = path.join(
                directory,
                await allocateName(directory, child.name, child.id, [], ""),
              );
              await ensureDirectory(dir);
              await withManifest(
                dir,
                async (manifest) => {
                  manifest.folder = {
                    id: child.id,
                    name: child.name,
                    url: "https://www.figma.com/files/folder/" + child.id,
                  };
                },
                options.recoverLocks ?? this.options.recoverLocks,
              );
            }
            if (folderIds.has(child.id)) {
              if (folderIds.get(child.id) !== dir)
                result.errors.push("Repeated remote folder ID: " + child.id);
              continue;
            }
            await visit(dir);
          } catch (error) {
            result.errors.push(
              child.id +
                ": " +
                (error instanceof Error
                  ? error.message
                  : "Folder discovery failed"),
            );
          }
        }
    };
    try {
      for (const directory of directories) {
        this.options.signal?.throwIfAborted();
        await visit(directory);
      }
    } finally {
      this.options.onProgress?.({
        phase: "download",
        message:
          "API discovery complete; draining " +
          pending.size +
          " queued/active downloads",
      });
      await Promise.all(pending);
      for (const lease of leases.reverse()) {
        try {
          await lease.release();
        } catch (error) {
          result.errors.push(
            error instanceof Error ? error.message : "Manifest release failed",
          );
        }
      }
    }
    this.options.signal?.throwIfAborted();
    return result;
  }
  private async downloadFile(
    api: FigmaApi,
    directory: string,
    manifest: Manifest,
    file: ManagedFile,
    initialLocal: { sha256: string } | null,
    force: boolean,
    ignoreMs: number,
  ): Promise<void> {
    const target = path.join(directory, file.localPath);
    const temp = path.join(directory, ".fig-download-" + randomUUID());
    try {
      this.options.onProgress?.({
        phase: "api",
        message: "Checking remote version before download: " + file.localPath,
      });
      const cached = this.cachedMetadata(file, ignoreMs);
      const before = cached ?? (await api.file(file.key));
      if (!cached) {
        file.name = before.name;
        file.remote = { ...file.remote, ...this.remote(before) };
        await saveManifest(directory, manifest);
      } else
        this.options.onProgress?.({
          phase: "api",
          message: "Reusing checked version before download: " + file.localPath,
        });
      if (before.editorType !== "figma")
        throw new Error("Document is not Figma Design.");
      this.options.signal?.throwIfAborted();
      await this.downloader.download(file.key, temp);
      this.options.signal?.throwIfAborted();
      await verifyNativeFile(temp);
      this.options.onProgress?.({
        phase: "api",
        message: "Verifying remote version after download: " + file.localPath,
      });
      const after = await api.file(file.key);
      file.name = after.name;
      file.remote = { ...file.remote, ...this.remote(after) };
      await saveManifest(directory, manifest);
      if (
        !before.version ||
        before.version !== after.version ||
        before.modifiedAt !== after.modifiedAt
      )
        throw new Error(
          "Document changed while downloading; kept previous local copy. Run sync again.",
        );
      const current = await hashFile(target);
      if (current?.sha256 !== initialLocal?.sha256)
        throw new Error(
          "Local file changed while downloading; refused to replace it.",
        );
      if (current && (!file.synced || current.sha256 !== file.synced.sha256)) {
        if (!force)
          throw new Error(
            "Local changes detected; use --force to back up and replace.",
          );
        await copyFile(
          target,
          target + ".backup-" + randomUUID(),
          constants.COPYFILE_EXCL,
        );
      }
      this.options.onProgress?.({
        phase: "download",
        message: "Hashing and committing download: " + file.localPath,
      });
      const downloaded = await hashFile(temp);
      if (!downloaded) throw new Error("Download missing.");
      this.options.signal?.throwIfAborted();
      await rename(temp, target);
      file.synced = {
        ...file.synced,
        version: after.version,
        modifiedAt: after.modifiedAt,
        downloadedAt: new Date().toISOString(),
        ...downloaded,
      };
      await saveManifest(directory, manifest);
    } finally {
      await unlink(temp).catch((error) => {
        if (!isNotFound(error)) throw error;
      });
    }
  }
}
export function createFigmaSync(options: ClientOptions = {}): FigmaSync {
  return new FigmaSync(options);
}
