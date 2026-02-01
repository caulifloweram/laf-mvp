#!/usr/bin/env node
/**
 * Permanently remove built-in stations from packages/client-web/src/main.ts
 * by stream URL. Use after hiding stations in the admin panel (or pass URLs directly).
 *
 * Usage:
 *   # Remove URLs listed in a file (one stream URL per line)
 *   node scripts/remove-built-in-stations.mjs scripts/stations-to-remove.txt
 *
 *   # Fetch hidden built-in URLs from API and remove them from code
 *   API_URL=https://your-api.up.railway.app node scripts/remove-built-in-stations.mjs --from-api
 *
 *   # Dry run: print what would be removed, do not edit main.ts
 *   DRY_RUN=1 node scripts/remove-built-in-stations.mjs scripts/stations-to-remove.txt
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const MAIN_TS = join(ROOT, "packages", "client-web", "src", "main.ts");
const BUILT_IN_URLS_JSON = join(__dirname, "built-in-stream-urls.json");

const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const FROM_API = process.argv.includes("--from-api");
const API_URL = process.env.API_URL || "";

function findMatchingBrace(content, startIndex, openChar, closeChar) {
  let depth = 0;
  let inString = null;
  let escape = false;
  let i = startIndex;
  while (i < content.length) {
    const c = content[i];
    if (escape) {
      escape = false;
      i++;
      continue;
    }
    if (inString) {
      if (c === "\\") escape = true;
      else if (c === inString) inString = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      i++;
      while (i < content.length && (content[i] !== inString || escape)) {
        if (content[i] === "\\") escape = true;
        else escape = false;
        i++;
      }
      if (i < content.length) i++;
      inString = null;
      continue;
    }
    if (c === openChar) {
      depth++;
      i++;
      continue;
    }
    if (c === closeChar) {
      depth--;
      if (depth === 0) return i;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

function skipComment(trimmed, i) {
  if (trimmed.slice(i, i + 2) === "//") {
    while (i < trimmed.length && trimmed[i] !== "\n") i++;
    return i;
  }
  if (trimmed.slice(i, i + 2) === "/*") {
    const end = trimmed.indexOf("*/", i + 2);
    return end === -1 ? trimmed.length : end + 2;
  }
  return i;
}

function getTopLevelBlocks(arrayContent) {
  const blocks = [];
  let i = 0;
  const trimmed = arrayContent.trim();
  if (!trimmed) return blocks;
  i = 0;
  while (i < trimmed.length) {
    // skip whitespace, commas, and comments
    while (i < trimmed.length) {
      if (/[\s,]/.test(trimmed[i])) {
        i++;
        continue;
      }
      if (trimmed.slice(i, i + 2) === "//" || trimmed.slice(i, i + 2) === "/*") {
        i = skipComment(trimmed, i);
        continue;
      }
      break;
    }
    if (i >= trimmed.length) break;
    if (trimmed[i] !== "{") break;
    const end = findMatchingBrace(trimmed, i, "{", "}");
    if (end === -1) break;
    const block = trimmed.slice(i, end + 1);
    blocks.push(block);
    i = end + 1;
  }
  return blocks;
}

function getStreamUrlsFromBlock(block) {
  const urls = [];
  const streamUrlRe = /streamUrl:\s*["'](https?:\/\/[^"']+)["']/g;
  let m;
  while ((m = streamUrlRe.exec(block)) !== null) urls.push(m[1]);
  return urls;
}

function blockHasChannels(block) {
  return /channels\s*:\s*\[/.test(block);
}

function removeChannelFromBlock(block, streamUrlToRemove) {
  const escaped = streamUrlToRemove.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\//g, "\\/");
  const channelLineRe = new RegExp(
    `\\s*\\{[^}]*streamUrl\\s*:\\s*["']${escaped}["'][^}]*\\}\\s*,?\\n?`,
    "g"
  );
  const next = block.replace(channelLineRe, "");
  if (next === block) return null;
  return next;
}

async function main() {
  let urlsToRemove = [];
  if (FROM_API && API_URL) {
    const builtInRaw = existsSync(BUILT_IN_URLS_JSON)
      ? readFileSync(BUILT_IN_URLS_JSON, "utf8")
      : "[]";
    const builtInUrls = new Set(JSON.parse(builtInRaw));
    let res;
    try {
      res = await fetch(`${API_URL.replace(/\/$/, "")}/api/station-overrides`);
    } catch (e) {
      console.error("Failed to fetch station-overrides:", e.message);
      process.exit(1);
    }
    if (!res.ok) {
      console.error("API returned", res.status);
      process.exit(1);
    }
    const overrides = await res.json();
    for (const row of overrides) {
      if (row.hidden === true && row.streamUrl && builtInUrls.has(row.streamUrl)) {
        urlsToRemove.push(row.streamUrl);
      }
    }
    console.log(`From API: ${urlsToRemove.length} hidden built-in URL(s) to remove`);
  } else {
    const fileArg = process.argv.find((a) => !a.startsWith("--") && a.endsWith(".txt"));
    if (!fileArg || !existsSync(fileArg)) {
      console.error("Usage: node scripts/remove-built-in-stations.mjs <file-with-urls.txt>");
      console.error("   or: API_URL=... node scripts/remove-built-in-stations.mjs --from-api");
      console.error("One stream URL per line in the file.");
      process.exit(1);
    }
    const text = readFileSync(fileArg, "utf8");
    urlsToRemove = text
      .split(/\n/)
      .map((l) => l.trim())
      .filter((l) => l && l.startsWith("http"));
    console.log(`From file: ${urlsToRemove.length} URL(s) to remove`);
  }
  if (urlsToRemove.length === 0) {
    console.log("Nothing to remove.");
    return;
  }
  const urlSet = new Set(urlsToRemove);
  const content = readFileSync(MAIN_TS, "utf8");
  const arrayStart = "const EXTERNAL_STATION_CONFIGS: ExternalStationConfig[] = [";
  const idx = content.indexOf(arrayStart);
  if (idx === -1) {
    console.error("EXTERNAL_STATION_CONFIGS declaration not found.");
    process.exit(1);
  }
  const openBracket = idx + arrayStart.length - 1;
  const closeBracket = findMatchingBrace(content, openBracket, "[", "]");
  if (closeBracket === -1) {
    console.error("Matching ] not found");
    process.exit(1);
  }
  const arrayContent = content.slice(openBracket + 1, closeBracket);
  if (arrayContent.length < 100) {
    console.error("Array content too short:", arrayContent.length);
    process.exit(1);
  }
  const before = content.slice(0, openBracket + 1);
  const after = content.slice(closeBracket);
  const blocks = getTopLevelBlocks(arrayContent);
  if (blocks.length === 0) {
    console.error("Could not parse any config blocks. arrayContent starts with:", JSON.stringify(arrayContent.slice(0, 300)));
    process.exit(1);
  }
  const newBlocks = [];
  let removedCount = 0;
  for (const block of blocks) {
    const blockUrls = getStreamUrlsFromBlock(block);
    const hasChannels = blockHasChannels(block);
    if (!hasChannels) {
      const remove = blockUrls.some((u) => urlSet.has(u));
      if (remove) {
        removedCount += blockUrls.length;
        continue;
      }
      newBlocks.push(block);
      continue;
    }
    let modified = block;
    let removedInBlock = 0;
    for (const u of blockUrls) {
      if (!urlSet.has(u)) continue;
      const next = removeChannelFromBlock(modified, u);
      if (next !== null) {
        modified = next;
        removedInBlock++;
      }
    }
    if (removedInBlock > 0) removedCount += removedInBlock;
    if (removedInBlock === blockUrls.length) continue;
    newBlocks.push(modified);
  }
  const newArrayContent = newBlocks.length ? newBlocks.map((b) => "  " + b).join(",\n") : "";
  const newContent = before + (newArrayContent ? "\n" + newArrayContent + "\n" : "") + after;
  if (DRY_RUN) {
    console.log("DRY RUN: would remove", removedCount, "stream(s) from EXTERNAL_STATION_CONFIGS");
    console.log("New array would have", newBlocks.length, "config(s).");
    return;
  }
  writeFileSync(MAIN_TS, newContent, "utf8");
  console.log("Removed", removedCount, "stream(s). Updated", MAIN_TS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
