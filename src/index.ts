export { createFigmaSync, FigmaSync, planFile } from "./sync.js";
export type { ProgressEvent, ProgressReporter } from "./progress.js";
export { listLocks, inspectLock, clearLock } from "./locks.js";
export type { LockInfo } from "./locks.js";
export type {
  ClientOptions,
  RunOptions,
  SyncItem,
  SyncResult,
  FileStatus,
} from "./sync.js";
export {
  MANIFEST_NAME,
  manifestSchema,
  emptyManifest,
  readManifest,
  ensureManifest,
} from "./manifest.js";
export type { Manifest, ManagedFile } from "./manifest.js";
export { RestFigmaApi, FigmaApiError, parseFigmaUrl } from "./api.js";
export type {
  FigmaApi,
  FileMetadata,
  FolderListing,
  FigmaReference,
} from "./api.js";
export {
  AuthStore,
  browserLogin,
  browserAuthenticated,
  defaultAuthDirectory,
} from "./auth.js";
export { login } from "./login.js";
export type { LoginOptions, LoginSteps } from "./login.js";
export { PlaywrightDownloader } from "./download.js";
export type { NativeDownloader, DownloadOptions } from "./download.js";
