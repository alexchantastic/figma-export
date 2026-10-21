# Changelog

All notable changes to Figma Files Sync are documented here. New features, improvements, and fixes are distinguished according to what each release actually changes.

## [1.1.0] - 2026-10-21

### Features

- Add `--ignore <duration>` to reuse recent successful API checks, such as `1m`, `30m` or `4h`, without skipping pending downloads. The window is relative to the last successful check; cache hits and failed requests do not extend it.
- Save successful metadata checks and folder listings before downloading, allowing interrupted syncs to resume from persisted state without repeating recent discovery. Downloads still require a final API version check before being marked synchronized.
- Add `--api-concurrency` to control concurrent API operations independently of browser download concurrency.
- Add `locks list` to inspect lock paths, owners and active/stale/unknown state, with recursive scanning and JSON output.
- Add `locks clear` and `--recover-locks` for stale-lock recovery. Legacy or unverifiable locks require explicit manual recovery; active local processes remain protected.
- Support cooperative cancellation through an `AbortSignal` in the library, and expose lock inspection and recovery through `listLocks`, `inspectLock`, `clearLock` and `LockInfo`.

### Improvements

- Run API discovery and native downloads in independent queues, allowing later files and folders to be checked while earlier documents download. Bound the pending download queue to avoid unbounded look-ahead.
- Show queue activity, cache reuse and discovery completion in progress logs.
- Include the absolute lock-file path, owner information and exact inspection/recovery commands in lock errors.
- Record lock hostname and unique ownership, and verify lock identity before removal to avoid deleting a replacement lock.
- Extend the manifest schema with optional successful-check and folder-cache fields while keeping existing manifests readable.

### Fixes

- Stop creating empty manifests for help, version, authentication commands, empty fetch/sync operations and failed registrations. Adding files or folders elsewhere no longer creates an unrelated parent manifest.
- Allow help and version commands to run when a project manifest is malformed, without modifying it. Data commands still reject invalid manifests.
- Preserve pending download state after failed or interrupted transfers, including when recent API checks are reused on retry. Only completed, validated downloads advance the synchronization baseline.
- Drain queued work before releasing directory locks, including when discovery or individual downloads fail.
- Abort cooperative API/browser work, close browser resources and release owned locks on SIGINT, SIGTERM and fatal errors. SIGKILL, power loss and unrecoverable crashes still require stale-lock recovery.

## [1.0.0] - 2026-10-20

### Features

- Initial release of the TypeScript library and CLI with `add`, `fetch` and incremental `sync`.
- Track native Figma files through per-directory manifests, persistent token/browser authentication and local conflict protection.
- Show live progress and reuse Chromium tabs with configurable download concurrency.
