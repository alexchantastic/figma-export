import { writeFile, mkdir } from "node:fs/promises";
import { z } from "zod";
import { manifestSchema } from "../dist/manifest.js";

const schema = z.toJSONSchema(manifestSchema, {
  io: "input",
  unrepresentable: "any",
});
schema.title = "Figma Files Sync directory manifest";
schema.description =
  "One .sync.fig.json per directory. Runtime validation additionally enforces safe filenames, Figma URLs and unique file keys / case-insensitive paths.";
await mkdir(new URL("../schemas/", import.meta.url), { recursive: true });
await writeFile(
  new URL("../schemas/manifest.schema.json", import.meta.url),
  JSON.stringify(schema, null, 2) + "\n",
);
