import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run with npm run test:package.");
const workspace = await mkdtemp(path.join(tmpdir(), "figma-package-"));
const consumer = path.join(workspace, "consumer");
const { version } = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
async function run(args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: {
        ...process.env,
        FIGMA_ACCESS_TOKEN: "",
        FIGMA_AUTH_COOKIE: "",
        XDG_CONFIG_HOME: path.join(workspace, "auth"),
        APPDATA: path.join(workspace, "auth"),
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error("Package check failed (" + code + "): " + stderr)),
    );
  });
}
try {
  await mkdir(consumer);
  const packed = JSON.parse(
    await run([npmCli, "pack", "--json", "--pack-destination", workspace]),
  );
  const info = packed[0];
  for (const file of info.files) {
    if (
      !["dist/", "schemas/"].some((prefix) => file.path.startsWith(prefix)) &&
      !["package.json", "README.md", "CHANGELOG.md", "LICENSE"].includes(
        file.path,
      )
    )
      throw new Error("Unexpected packaged file: " + file.path);
  }
  const tarball = path.join(workspace, info.filename);
  // Normal production install: do not suppress lifecycle scripts.
  await run([
    npmCli,
    "install",
    "--prefix",
    consumer,
    tarball,
    "--omit=dev",
    "--no-audit",
    "--no-fund",
  ]);
  const bin = path.join(
    consumer,
    "node_modules",
    "figma-files-sync",
    "dist",
    "cli.js",
  );
  if ((await run([bin, "--version"], consumer)).trim() !== version)
    throw new Error("CLI version mismatch.");
  const result = JSON.parse(
    await run(
      [
        npmCli,
        "exec",
        "--offline",
        "--",
        "figma-files-sync",
        "fetch",
        "--json",
      ],
      consumer,
    ),
  );
  if (result.items.length || result.errors.length)
    throw new Error("Empty npm exec/npx failed.");
  const { readdir } = await import("node:fs/promises");
  if ((await readdir(consumer)).includes(".sync.fig.json"))
    throw new Error("Read-only commands created an empty manifest.");
  await run(
    [
      "--input-type=module",
      "-e",
      "import {emptyManifest} from 'figma-files-sync'; import {createRequire} from 'node:module'; createRequire(import.meta.url).resolve('figma-files-sync/manifest.schema.json'); if(emptyManifest().schemaVersion!==1)process.exit(1);",
    ],
    consumer,
  );
  for (const file of info.files.filter((file) =>
    /[.](js|json|md)$/.test(file.path),
  )) {
    const content = await readFile(
      path.join(consumer, "node_modules", "figma-files-sync", file.path),
      "utf8",
    );
    if (/figd_[a-zA-Z0-9_-]{20,}/.test(content))
      throw new Error("Possible credential in packaged file: " + file.path);
  }
  console.log(
    "Package " +
      version +
      " passed: allowlisted contents, production install, executable, npm exec/npx, ESM and schema exports.",
  );
} finally {
  await cleanup();
}
async function cleanup() {
  const resolved = path.resolve(workspace);
  if (
    path.dirname(resolved) !== path.resolve(tmpdir()) ||
    !path.basename(resolved).startsWith("figma-package-")
  )
    throw new Error("Unexpected cleanup path.");
  await rm(resolved, { recursive: true, force: true });
}
