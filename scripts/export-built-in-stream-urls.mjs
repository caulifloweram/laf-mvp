#!/usr/bin/env node
/**
 * Extract all stream URLs from client EXTERNAL_STATION_CONFIGS (main.ts).
 * Writes a JSON array of unique stream URLs for use by test-and-remove-stations.mjs.
 * Usage: node scripts/export-built-in-stream-urls.mjs
 */

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_TS = join(__dirname, "..", "packages", "client-web", "src", "main.ts");

const content = readFileSync(MAIN_TS, "utf8");
const urlRegex = /streamUrl:\s*["'](https?:\/\/[^"']+)["']/g;
const urls = new Set();
let m;
while ((m = urlRegex.exec(content)) !== null) urls.add(m[1]);

const outPath = join(__dirname, "built-in-stream-urls.json");
writeFileSync(outPath, JSON.stringify([...urls].sort(), null, 2), "utf8");
console.log(`Wrote ${urls.size} unique stream URLs to ${outPath}`);
