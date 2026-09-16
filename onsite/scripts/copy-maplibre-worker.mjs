// MapLibre 6 runs its tile worker from separate module files. Bundlers rewrite import.meta.url in ways
// MapLibre can't resolve (under Turbopack the worker silently fails and GeoJSON layers never draw), so we
// serve the exact files from node_modules at /maplibre/<version>/ and MapPicker points MapLibre at them.
// Runs on install, dev and build. The version in the path keeps the worker in step with the library.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "node_modules/maplibre-gl/dist");
const files = ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"];
if (!files.every((f) => fs.existsSync(path.join(dist, f)))) process.exit(0);   // half-installed: leave what's being served alone
const { version } = JSON.parse(fs.readFileSync(path.join(root, "node_modules/maplibre-gl/package.json"), "utf8"));
const base = path.join(root, "public/maplibre");
fs.mkdirSync(path.join(base, version), { recursive: true });
for (const f of files) fs.copyFileSync(path.join(dist, f), path.join(base, version, f));
for (const old of fs.readdirSync(base)) if (old !== version) fs.rmSync(path.join(base, old), { recursive: true, force: true });
console.log(`maplibre worker ${version} → public/maplibre/${version}/`);
