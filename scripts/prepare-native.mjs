import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "www");
const files = [
  "index.html",
  "baixar.html",
  "styles.css",
  "app.mjs",
  "editor-core.mjs",
  "project-backup.mjs",
  "local-profiles.mjs",
  "update-check.mjs",
  "version.json",
  "media-store.mjs",
  "renderer.mjs",
  "export-engine.mjs",
  "smart-assistant.mjs",
  "music-library.mjs",
  "manifest.webmanifest",
  "sw.js",
];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of files) await cp(join(root, file), join(output, file));
await cp(join(root, "icons"), join(output, "icons"), { recursive: true });
console.log(`Arquivos nativos preparados em ${output}`);
