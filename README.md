# Figma Files Sync

Keep native Figma Design files synchronized locally with their original documents.

**Figma Files Sync** is a CLI and TypeScript library by Victor Wads. Register files or folders once, check remote changes with `fetch`, and download only new, changed or missing `.fig` files with `sync`.

Standalone, with no OpenPencil dependency. Portable directory manifests let any application associate local files with their Figma sources.

> Initial release: automated tests use simulated Figma responses and downloads. Native downloads depend on Figma’s web UI and still require an authorized live smoke test before relying on this as a backup. A tag-based GitHub Actions workflow supports npm Trusted Publishing (OIDC), after the one-time npm trust setup.

## Install

Requires **Node.js 22.12+**. Install globally or run via `npx`:

```sh
npm install -g figma-files-sync
# Or:
npx figma-files-sync --help
```

No global install is required for the full workflow:

```sh
mkdir my-designs
cd my-designs
npx figma-files-sync login
npx figma-files-sync add "https://www.figma.com/design/FILE_KEY/Homepage"
npx figma-files-sync fetch
npx figma-files-sync sync
```

Login offers Chromium installation when needed. Credentials are saved in your user configuration directory and survive temporary npx installs. Use `npx figma-files-sync@latest ...` to explicitly request the latest release.

### Use the local checkout as a command

From the repository directory:

```sh
npm ci
npm link
figma-files-sync --help
```

The `prepare` lifecycle builds the CLI automatically during `npm ci` and `npm link`. The global command points to this checkout; no npm publication is required.

Then switch to the directory where you want your Figma files and authenticate:

```sh
cd /path/to/your/designs
figma-files-sync install-browser
figma-files-sync login
figma-files-sync add "https://www.figma.com/design/FILE_KEY/Homepage"
figma-files-sync fetch
figma-files-sync sync
```

After editing TypeScript sources, run `npm run build` in the repository. The linked command uses the rebuilt output without linking again.

To remove the global link:

```sh
npm unlink -g figma-files-sync
```

With nvm, the link belongs to the active Node installation. If you switch Node versions, run `npm link` again using that version. If the command is not found, check that `$(npm prefix -g)/bin` is in your `PATH` (on Unix). Do not use `sudo` to work around a Node/npm configuration issue.

Alternatively, without linking: `npm run build` and `node dist/cli.js --help`.

Package installation does **not** download a browser. Simply run:

```sh
figma-files-sync login
```

If Chromium is missing, interactive login offers to download/install it and continues after confirmation. Installed browsers are reused. Use `login --install-browser` to authorize installation without a prompt, or `figma-files-sync install-browser` to install separately. Non-interactive runs never wait for an installation prompt. OS/permission errors are reported rather than triggering repeated reinstalls.

## Quick start

```sh
figma-files-sync add https://www.figma.com/design/FILE_KEY/Homepage
figma-files-sync add https://www.figma.com/files/folder/123456789/Wireframes wireframes
figma-files-sync fetch
figma-files-sync sync
```

A `.sync.fig.json` is created **only when registering or persisting managed state** in that directory. Help, version and authentication commands never read or create project manifests. Fetch/sync process existing manifests without creating empty ones, and failed registrations leave no empty manifest. Its base structure is:

```json
{
  "schemaVersion": 1,
  "folder": null,
  "files": []
}
```

Folder registrations and their subfolders use the same filename:

```text
project/
├── .sync.fig.json
├── Homepage.fig
└── wireframes/
    ├── .sync.fig.json
    ├── Login.fig
    └── mobile/
        ├── .sync.fig.json
        └── Dashboard.fig
```

## Commands

| Command                            | Behavior                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| `add <url> [directory]`            | Merge a file/folder registration and download pending files.                                |
| `fetch`                            | Refresh remote metadata and discover new folder files. No browser or native download.       |
| `sync`                             | Fetch and download new, changed or locally missing files.                                   |
| `login`                            | Check token and browser; skip valid credentials and configure only what is missing/expired. |
| `login --only-token`               | Check/configure only the API token.                                                         |
| `login --only-token --token-stdin` | Replace token from stdin, without browser setup.                                            |
| `login --only-browser`             | Check/configure only the browser session.                                                   |
| `login --install-browser`          | Install Chromium and run the default login flow.                                            |
| `auth status`                      | Show configured credentials without exposing secrets or making network requests.            |
| `logout`                           | Remove saved credentials; environment overrides remain active.                              |
| `install-browser`                  | Explicitly install Playwright Chromium.                                                     |

Options:

- `fetch --no-recursive` / `sync --no-recursive`: process only the current directory.
- `sync --force` / `add --force`: back up and replace **local conflicts**. Unchanged documents are still skipped.
- `--json`: structured results for add/fetch/sync/auth status/logout. Interactive login and browser installation are not JSON operations.
- `--headed` or `--no-headless`: show Chromium while downloading, e.g. `figma-files-sync add <url> --no-headless`.
- `--concurrency 2`: up to two download tabs in one Chromium; accepts 1–3, default 1.
- `--api-concurrency 2`: up to two concurrent API operations, independently of browser tabs; accepts 1–3, default 1. Applies to discovery and the version checks around native downloads.
- `--ignore 10m`: reuse successful API observations from the last 10 minutes. Accepts positive durations with `s`, `m`, `h` or `d`, e.g. `30s`, `1m`, `30m`, `4h`. Pending/missing downloads are **not** skipped.
- `--timeout 300`: editor/download timeout in seconds.
- `--auth-dir <directory>`: override the credential directory.

Add/fetch/sync report progress immediately to **stderr**: API requests and responses, discovered file/subfolder counts, per-directory file N/total, browser startup, editor/menu waits, download start, validation and final file status. During long waits a heartbeat repeats the current stage every 15 seconds. `--json` keeps stdout as a single JSON result; redirect stderr if only machine output is needed. Playwright does not expose a reliable native download percentage, so no estimated percentage is fabricated.

Exit code `0` means success; `1` means an error, conflict, unavailable document or unsupported file. Fetch reporting pending updates is successful.

## Authentication

Native synchronization needs two independent credentials:

1. A **Figma REST personal access token** for metadata/discovery.
2. A **Figma browser session** for “Save local copy”. A token cannot download native files on its own.

Create a personal access token in Figma settings with `file_metadata:read`, `folders:read` (for folders) and `current_user:read` (for login validation).

The login browser supports normal SSO and 2FA. Passwords are not saved. `login` always considers both credentials and validates existing ones before skipping their setup. Valid browser sessions are checked headlessly, without opening an interactive login window. Use `login --only-token` or `login --only-browser` to limit the flow. To replace valid credentials explicitly, use `login --force` (or `login --only-token --force` / `login --only-browser --force`). Network/API verification failures are reported rather than assumed to mean expired credentials. Both selected steps are attempted independently, so a token failure does not prevent browser setup; the overall command fails if either step fails. `--token-stdin` explicitly replaces the token even if one is already valid and does not limit the flow by itself. Legacy automated password login is intentionally removed.

Environment overrides:

```sh
export FIGMA_ACCESS_TOKEN="..."
# Advanced: existing __Host-figma.authn cookie
export FIGMA_AUTH_COOKIE="..."
```

No `.env` is loaded implicitly. Environment variables override saved credentials; the library’s explicit `token` takes precedence over both.

Storage: `$XDG_CONFIG_HOME/figma-files-sync` or `~/.config/figma-files-sync` on Unix; `%APPDATA%/figma-files-sync` on Windows. Files use mode `0600` and the directory `0700` where supported. They are **not encrypted**; Windows ACLs and OS controls remain your responsibility. Never commit tokens, session files or traces. Use the same account for token and browser.

Public OAuth apps currently cannot use the folder-listing endpoints. This release uses personal tokens without introducing an OAuth service.

## Manifest contract

Each directory has at most one `.sync.fig.json`. It may associate a remote folder, individual files, or both:

```json
{
  "schemaVersion": 1,
  "folder": {
    "id": "123456789",
    "url": "https://www.figma.com/files/folder/123456789/Wireframes",
    "name": "Wireframes",
    "lastFetchedAt": "2026-10-20T02:00:00Z"
  },
  "files": [
    {
      "key": "AbCdEf123456",
      "url": "https://www.figma.com/design/AbCdEf123456/Login",
      "name": "Login",
      "localPath": "Login.fig",
      "remote": {
        "version": "987654321",
        "modifiedAt": "2026-10-19T23:00:00Z",
        "checkedAt": "2026-10-20T02:00:00Z",
        "availability": "available",
        "membership": "present"
      },
      "synced": null
    }
  ]
}
```

After a successful download, `synced` records `version`, `modifiedAt`, `downloadedAt`, `sha256` and `size`. **Fetch never advances this baseline.**

- Keys and versions are opaque strings; dates are UTC ISO 8601.
- Original registered URLs are retained. Folder-discovered files get canonical Design URLs.
- `localPath` is a safe filename relative to the manifest’s directory.
- Adds merge by key, without removing previous entries.
- Local filenames remain stable after remote renames. Collisions receive ID-derived suffixes; untracked files are not overwritten.
- Invalid/future schemas fail closed. Unknown extra fields are preserved.
- `membership: absent` means absence from a successful listing, not proven deletion.
- Credentials never belong here. Document names/URLs may still be private.

The npm package includes `figma-files-sync/manifest.schema.json`. Runtime validation additionally enforces safe filenames, Figma URLs and unique keys/case-insensitive filenames. The JSON has no application-specific dependencies.

## Synchronization and recovery

- Fetch uses lightweight metadata endpoints, not full document JSON.
- Sync compares remote version, successful-download baseline and local presence/hash.
- Unchanged remote/local pairs cause **zero native downloads**.
- Locally modified files become conflicts. `--force` preserves a sibling `.fig.backup-<id>` before replacing them.
- One Chromium process and one authenticated context are reused per client/CLI execution. A bounded pool reuses editor tabs; successful downloads leave the Figma editor loaded, rather than navigating to a blank page. Failed tabs are discarded without restarting the whole browser.
- When a visible same-tab link to the next document already exists in the Figma UI, the downloader clicks it so Figma can use its own client-side navigation. Otherwise it falls back to normal document navigation in the same tab. It never fakes `pushState`, sends synthetic router events or uses undocumented router internals. **Same-tab reuse does not guarantee SPA navigation**: Figma controls how each link loads, and cross-document navigation may still reload the application. Logs distinguish these paths.
- Downloads are sequential by default. Use `--concurrency 2` or `--concurrency 3` to overlap editor loads/transfers in separate tabs of that same browser, e.g. `figma-files-sync sync --concurrency 2 --no-headless`. The API producer and native-download consumers run independently: pending files enter the browser queue immediately, while metadata checks and recursive folder discovery continue. This uses asynchronous I/O in one Node process, not worker threads.
- Discovery looks ahead into a bounded download backlog (high-water mark 32, plus at most the in-flight metadata producers). When it fills, discovery pauses until a download settles instead of consuming unbounded memory. A retry/rate-limit wait occupies its API slot but does not pause a browser transfer already in progress. Browser jobs still require before/after API version checks, which may themselves wait on rate limits. Folder traversal remains sequential, but it no longer waits for that folder’s downloads to finish.
- Editor starts are staggered by at least 10 seconds even in concurrent mode; this is not a bypass for Figma rate limits. Parallel tabs increase RAM usage and may trigger anti-automation safeguards: reduce concurrency if downloads fail.
- Manifest and browser-session writes are serialized so concurrent workers cannot commit stale snapshots over newer ones. Directory locks remain held until all workers settle. The browser closes only when the client closes / CLI operation finishes (separate CLI invocations do not share a background browser).
- Native downloads are staged beside the destination, checked for empty/error responses, then renamed. This is not full validation of Figma’s proprietary format.
- Metadata checks before/after download detect concurrent remote edits and preserve the previous local file. This is best-effort, **not a transactional snapshot guarantee**.
- Remote deletion, lost access and discovery errors never delete local copies or historical registrations.
- Moved remote documents retain their established local path inside a scanned tree rather than being copied again. Automatic physical relocation is not performed.
- Explicit independent destinations can maintain intentional copies; there is no hidden global registry.
- Recursive scans skip hidden directories, `node_modules`, `dist` and `coverage`, and do not follow directory symlinks.

Manifests are written atomically and saved as work completes. Each operation locks its directory with `.sync.fig.lock`. On SIGINT/SIGTERM and fatal errors, the CLI aborts cooperative work, drains its queues, closes browser resources and releases its owned locks. SIGKILL, power loss and unrecoverable runtime crashes cannot guarantee cleanup; recovery is described below. Never replace a damaged manifest with an empty one: repair or restore it. Staged files left by abrupt interruption can be removed after verifying no operation is active.

File replacement and manifest commit are separate filesystem operations: a crash between them is conservatively reported as a local conflict on the next run.

There is no upload, two-way merge, automatic pruning, background watcher or legacy `files.json` migration.

## Retry without repeating recent API checks

For an interrupted synchronization:

```sh
figma-files-sync sync --ignore 10m
# Independent API/browser limits still apply:
figma-files-sync sync --ignore 30m --api-concurrency 2 --concurrency 1
```

The window is measured from the **last successful API check**, not from process startup, a download attempt, or a cache hit. Successful metadata is checkpointed atomically before local hashing and download enqueueing. A failed download leaves remote version and successful-check time intact, but does not advance `synced`. A new process therefore retries the pending download using known remote metadata instead of repeating discovery.

File metadata stores `remote.lastSuccessfulCheckedAt` and `remote.editorType` alongside the existing `checkedAt` (latest observed attempt/result). Folder listings store `folder.lastFetchedAt` and `folder.subfolders`, allowing child traversal to resume even when the folder-listing API call is skipped. A listing alone does not certify per-file metadata. Old manifests lacking these optional cache fields are refreshed once; failures, unavailable documents, incomplete metadata and future timestamps never qualify as fresh successful cache entries. Cache hits never extend timestamps.

**Safety:** the optional cache skips discovery/per-file planning calls and a recent pre-download version check. The post-download API version check is always performed before committing a successful native download. A changed version, failed confirmation or interrupted transfer leaves `synced` untouched for retry. This intentionally means pending downloads may still make a validation API request; `--ignore` is not an offline or unverified-download mode. While using cached folder listings, newly created remote entries will not be discovered until the window expires (omit `--ignore` to refresh immediately).

After abrupt process termination, lock recovery remains explicit: verify that no previous process is active before removing its `.sync.fig.lock`. Inspect with `figma-files-sync locks list [directory]` (recursive; `--no-recursive` limits the scan). Errors print the absolute lock path, owner and quoted inspection/recovery commands. Use `figma-files-sync locks clear "directory"` for a proven stale same-host lock, or `--recover-locks` on add/fetch/sync to recover those automatically. Unknown/legacy locks require manual verification and `locks clear "directory" --force`. Active local PIDs are never bypassed, even with force; PID reuse is treated conservatively. Locks on another host cannot be verified using local process state. Recovery compares the lock identity before deletion, and normal cleanup only removes its own owner token. Cached metadata does not bypass locks or local-edit conflict protection. Queues are in memory, but pending work is reconstructed from persisted remote/synced state rather than lost with the process.

In the library, use `client.sync({ cwd, ignore: "10m" })` (or a client-level `ignore` default). Per-operation options override the client default. No cache window is applied unless explicitly requested.

## TypeScript library

```ts
import { createFigmaSync, readManifest } from "figma-files-sync";

const client = createFigmaSync({
  token: process.env.FIGMA_ACCESS_TOKEN,
  onEvent: (item) => console.log(item.status, item.localPath),
});

try {
  await client.add("https://www.figma.com/design/FILE_KEY/Homepage", {
    cwd: "./project",
  });
  const pending = await client.fetch({ cwd: "./project" });
  const result = await client.sync({ cwd: "./project" });
  const manifest = await readManifest("./project");
  // Handle result.errors and item statuses; partial failures preserve successes.
} finally {
  await client.close();
}
```

ESM exports include manifest types/schema/readers, REST client, authentication helpers and pure `planFile`. Importing does not create files, open a browser or load environment files. Inject `api` and `downloader` adapters for integration/testing. Use separate clients for concurrent operations; do not close a working client.

## Limitations

Only **Figma Design `.fig`** initially. FigJam, Slides, PDFs, assets and saved historical-version URLs are out of scope. Native copies omit comments/history and do not retain their original cloud connection; the manifest preserves the source association.

Downloads automate **File → Save local copy** in the English-language web app, not an official native-download REST endpoint. UI changes may break automation. Export permissions and organization restrictions are respected, never bypassed. Disable desktop-app link opening if it prevents downloads. Diagnose with `--headed` and a longer `--timeout`.

Scopes, folder support and rate limits depend on Figma. Short `Retry-After` responses receive bounded retries; long intervals fail promptly for a later retry. A 403/404 does not prove deletion. Incomplete folder discovery is an error, never an empty successful result.

Only synchronize content you are authorized to access/export. Review Figma’s terms for your use case.

## Development

```sh
npm ci
npm run check
npm run format:check
npm pack
```

Tests use temporary directories and simulated API/downloader adapters, without real credentials. They cover idempotency, versions, missing files, conflicts/backups, partial discovery, concurrent edits, URLs, symlinks and locks. CI verifies Node 22/24 on Linux, macOS and Windows.

Before publication, perform an authorized live smoke test: login, add a small Design file/folder, rerun unchanged, edit remotely, fetch without downloading, sync, and verify the resulting file imports into Figma. Mocked tests do not replace this step.

## License and acknowledgments

MIT. Developed by **Victor Wads**. The project grew from [Alex Chan’s figma-export](https://github.com/alexchantastic/figma-export), retaining its history and Figma API discovery / Playwright download foundations. The original copyright and permission notice remain in LICENSE.

## Publishing (maintainers)

See [the release guide](https://github.com/victorwads/figma-files-sync/blob/main/docs/releasing.md) for bootstrap, npm Trusted Publisher configuration and tag-based OIDC releases. The workflow uses no long-lived npm token.
