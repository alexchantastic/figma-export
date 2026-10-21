import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import type { ProgressReporter } from "./progress.js";

export class FigmaApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "FigmaApiError";
  }
}
export interface FileMetadata {
  key: string;
  name: string;
  version: string | null;
  modifiedAt: string | null;
  editorType: string;
}
export interface FolderInfo {
  id: string;
  name: string;
}
export interface FolderListing {
  name: string;
  files: { key: string; name: string }[];
  folders: FolderInfo[];
}
export interface FigmaApi {
  file(key: string): Promise<FileMetadata>;
  folder(id: string): Promise<FolderListing>;
  validateToken(): Promise<void>;
}
const metadata = z.object({
  file: z.object({
    name: z.string(),
    version: z.string(),
    last_touched_at: z.iso.datetime(),
    editorType: z.string(),
  }),
});
const filesSchema = z.object({
  name: z.string().optional(),
  files: z.array(
    z.object({ key: z.string().regex(/^[a-zA-Z0-9_-]+$/), name: z.string() }),
  ),
});
const folderSchema = z.object({
  folders: z.array(
    z.object({
      id: z
        .union([z.string(), z.number()])
        .transform(String)
        .pipe(z.string().regex(/^\d+$/)),
      name: z.string(),
    }),
  ),
});
export class RestFigmaApi implements FigmaApi {
  constructor(
    private readonly token: string,
    private readonly request: typeof fetch = fetch,
    private readonly onProgress?: ProgressReporter,
    private readonly signal?: AbortSignal,
  ) {}
  private async get(endpoint: string): Promise<unknown> {
    if (!this.token)
      throw new Error(
        "No Figma API token. Run figma-files-sync login --only-token or set FIGMA_ACCESS_TOKEN.",
      );
    for (let attempt = 0; ; attempt++) {
      this.onProgress?.({
        phase: "api",
        message:
          "Figma API GET " +
          endpoint +
          (attempt ? " (retry " + attempt + ")" : ""),
      });
      const response = await this.request("https://api.figma.com" + endpoint, {
        headers: { "X-FIGMA-TOKEN": this.token },
        signal: AbortSignal.any([
          AbortSignal.timeout(30_000),
          ...(this.signal ? [this.signal] : []),
        ]),
        redirect: "error",
      });
      this.onProgress?.({
        phase: "api",
        message: "Figma API " + response.status + " — " + endpoint,
      });
      if (response.ok) return response.json();
      const retry = Number(response.headers.get("Retry-After") ?? "1");
      if (
        attempt < 2 &&
        (response.status === 429 || response.status >= 500) &&
        Number.isFinite(retry) &&
        retry >= 0 &&
        retry <= 60
      ) {
        this.onProgress?.({
          phase: "api",
          message:
            "API " +
            response.status +
            ": waiting " +
            Math.max(retry, attempt + 1) +
            "s before retry",
        });
        await response.body?.cancel();
        await delay(Math.max(1000 * retry, 1000 * (attempt + 1)), undefined, {
          signal: this.signal,
        });
        continue;
      }
      await response.body?.cancel();
      const hint =
        response.status === 429
          ? "Rate limited; retry later (respect Retry-After)."
          : response.status === 403
            ? "Token expired, missing scopes, or resource inaccessible."
            : response.status === 404
              ? "Resource missing or inaccessible."
              : "Request failed.";
      throw new FigmaApiError(
        response.status,
        "Figma API " + response.status + ": " + hint,
      );
    }
  }
  async file(key: string): Promise<FileMetadata> {
    const { file } = metadata.parse(
      await this.get("/v1/files/" + encodeURIComponent(key) + "/meta"),
    );
    return {
      key,
      name: file.name,
      version: file.version,
      modifiedAt: file.last_touched_at,
      editorType: file.editorType,
    };
  }
  async folder(id: string): Promise<FolderListing> {
    const files = filesSchema.parse(
      await this.get("/v2/folders/" + encodeURIComponent(id) + "/files"),
    );
    // A subfolder error must fail discovery, never silently masquerade as an empty list.
    const children = folderSchema.parse(
      await this.get("/v2/folders/" + encodeURIComponent(id) + "/folders"),
    );
    return {
      name: files.name ?? "Folder " + id,
      files: files.files,
      folders: children.folders,
    };
  }
  async validateToken(): Promise<void> {
    await this.get("/v1/me");
  }
}
export type FigmaReference = {
  kind: "file" | "folder";
  id: string;
  url: string;
};
export function parseFigmaUrl(value: string): FigmaReference {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Expected a full HTTPS Figma file or folder URL.");
  }
  if (
    url.protocol !== "https:" ||
    !["figma.com", "www.figma.com"].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password
  )
    throw new Error("Expected an HTTPS figma.com URL.");
  if (url.searchParams.has("version-id"))
    throw new Error(
      "Pinned version URLs are not supported; register the live document URL.",
    );
  const file = url.pathname.match(
    /^\/(?:design|file|proto)\/([a-zA-Z0-9_-]+)(?:\/|$)/,
  );
  if (file?.[1]) return { kind: "file", id: file[1], url: value };
  const folder =
    url.pathname.startsWith("/files/") &&
    url.pathname.match(/\/(?:folder|project)\/(\d+)(?:\/|$)/);
  if (folder && folder[1]) return { kind: "folder", id: folder[1], url: value };
  throw new Error(
    "Unsupported Figma URL. Use a Design file or a folder/project link.",
  );
}
