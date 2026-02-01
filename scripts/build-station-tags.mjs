#!/usr/bin/env node
/**
 * Builds a complete station-tags.json from EXTERNAL_STATION_CONFIGS in client-web.
 * Every streamUrl gets at least one group and optional tags, derived from name + description.
 * Output: packages/client-web/public/station-tags.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainTsPath = path.join(__dirname, "../packages/client-web/src/main.ts");
const outPath = path.join(__dirname, "../packages/client-web/public/station-tags.json");

const TAXONOMY = {
  groups: ["college", "experimental", "arts", "electronic", "world", "community", "eclectic", "talk", "other"],
  tagKeywords: [
    "ambient", "electronic", "techno", "house", "dub", "experimental", "freeform", "jazz", "soul", "hiphop",
    "rock", "folk", "world", "classical", "metal", "punk", "disco", "dance", "eclectic", "shoegaze", "darkwave",
    "community", "college", "arts", "feminist", "talk", "chill", "underground"
  ],
};

const TAG_MAP = {
  electro: "electronic", electronica: "electronic", idm: "electronic",
  dubstep: "dub", reggae: "dub", avantgarde: "experimental", leftfield: "experimental",
  nujazz: "jazz", jazzfunk: "jazz", rnb: "soul", postpunk: "rock", alternative: "rock",
  global: "world", african: "world", brazilian: "world",
  noncommercial: "community", listenersupported: "community",
  university: "college", student: "college", campus: "college",
  artistrun: "arts", culture: "arts", garage: "rock", indie: "rock",
};

function deriveGroupAndTags(name, description) {
  const n = (name || "").toLowerCase();
  const d = (description || "").toLowerCase();
  const text = n + " " + d;

  const tags = new Set();
  const keywordPairs = [
    ["ambient", "ambient"], ["drone", "ambient"], ["electronic", "electronic"], ["house", "house"], ["techno", "techno"],
    ["dub", "dub"], ["experimental", "experimental"], ["sound art", "experimental"], ["avant-garde", "experimental"],
    ["freeform", "freeform"], ["jazz", "jazz"], ["soul", "soul"], ["funk", "soul"], ["hip-hop", "hiphop"], ["hip hop", "hiphop"],
    ["rock", "rock"], ["indie", "rock"], ["folk", "folk"], ["world", "world"], ["classical", "classical"],
    ["metal", "metal"], ["punk", "punk"], ["disco", "disco"], ["dance", "dance"], ["eclectic", "eclectic"],
    ["community", "community"], ["college", "college"], ["university", "college"], ["student", "college"],
    ["arts", "arts"], ["artist-run", "arts"], ["feminist", "feminist"], ["talk", "talk"], ["underground", "underground"],
  ];
  for (const [kw, tag] of keywordPairs) {
    if (text.includes(kw)) tags.add(tag);
  }
  const finalTags = [...tags].slice(0, 8);
  if (finalTags.length === 0) finalTags.push("eclectic");

  // Primary group (single): priority order so each station gets exactly one
  if (/\b(college|university|student|campus)\b/.test(text)) return { group: "college", tags: [...new Set([...finalTags, "college"])].slice(0, 8) };
  if (/\b(experimental|sound art|avant[- ]?garde|noise|drone)\b/.test(text)) return { group: "experimental", tags: [...new Set([...finalTags, "experimental"])].slice(0, 8) };
  if (/\b(arts|artist[- ]?run)\b/.test(text)) return { group: "arts", tags: [...new Set([...finalTags, "arts"])].slice(0, 8) };
  if (/\b(electronic|house|techno|ambient|dub|dance|ebm|darkwave)\b/.test(text)) return { group: "electronic", tags: [...new Set([...finalTags, "electronic"])].slice(0, 8) };
  if (/\b(world|global|iwi|māori|african|arab)\b/.test(text)) return { group: "world", tags: [...new Set([...finalTags, "world"])].slice(0, 8) };
  // Listener-supported / multi-channel / "Where the Music Matters" → eclectic
  if (/\b(listener[- ]?supported|multiple channel|two live channel|where the music matters)\b/.test(text)) return { group: "eclectic", tags: [...new Set([...finalTags, "eclectic"])].slice(0, 8) };
  if (/\b(community|non[- ]?commercial|diy|independent)\b/.test(text)) return { group: "community", tags: [...new Set([...finalTags, "community"])].slice(0, 8) };
  if (/\b(freeform|eclectic|variety|mixed)\b/.test(text)) return { group: "eclectic", tags: [...new Set([...finalTags, "eclectic"])].slice(0, 8) };
  if (/\b(talk|news|opinion)\b/.test(text) && !/\b(music|rock|jazz)\b/.test(text)) return { group: "talk", tags: [...new Set([...finalTags, "talk"])].slice(0, 8) };
  return { group: "other", tags: [...new Set([...finalTags, "eclectic"])].slice(0, 8) };
}

function extractStations(tsContent) {
  const blocks = [];
  const arrayStart = tsContent.indexOf("const EXTERNAL_STATION_CONFIGS");
  if (arrayStart === -1) throw new Error("EXTERNAL_STATION_CONFIGS not found");
  const fromArray = tsContent.slice(arrayStart);
  const openBracket = fromArray.indexOf("[");
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  let quote = null;
  for (let i = openBracket; i < fromArray.length; i++) {
    const ch = fromArray[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (!inString) {
      if ((ch === '"' || ch === "'") && fromArray[i - 1] !== "\\") { inString = true; quote = ch; continue; }
      if (ch === "{") { if (depth === 0) start = i; depth++; continue; }
      if (ch === "}") {
        depth--;
        if (depth === 0 && start !== -1) {
          const block = fromArray.slice(start, i + 1);
          const nameMatch = block.match(/name:\s*["']((?:[^"']|\\["'])*)["']/);
          const descMatch = block.match(/description:\s*["']((?:[^"']|\\["'])*)["']/);
          const streamMatch = block.match(/streamUrl:\s*["']([^"']*)["']/);
          const channelUrls = [];
          const channelRe = /streamUrl:\s*["']([^"']*)["']/g;
          let m;
          const channelsMatch = block.match(/channels:\s*\[/);
          if (channelsMatch) {
            const chanStart = block.indexOf("channels:");
            const chanBlock = block.slice(chanStart);
            while ((m = channelRe.exec(chanBlock)) !== null) channelUrls.push(m[1]);
          }
          const name = nameMatch ? nameMatch[1].replace(/\\"/g, '"') : "";
          const description = descMatch ? descMatch[1].replace(/\\"/g, '"') : "";
          const streamUrl = streamMatch ? streamMatch[1] : null;
          if (streamUrl) blocks.push({ name, description, streamUrl, channelUrls });
        }
        continue;
      }
    } else {
      if (ch === quote) inString = false;
    }
  }
  return blocks;
}

const ts = fs.readFileSync(mainTsPath, "utf8");
const stations = extractStations(ts);
const out = { _comment: "Map streamUrl -> { tags, group }. Every built-in station indexed. See scripts/build-station-tags.mjs." };

for (const s of stations) {
  const { group, tags } = deriveGroupAndTags(s.name, s.description);
  out[s.streamUrl] = { tags, group };
  for (const url of s.channelUrls || []) {
    if (url && url !== s.streamUrl) out[url] = { tags, group };
  }
}

fs.writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");
console.log(`Wrote ${Object.keys(out).filter((k) => !k.startsWith("_")).length} entries to ${outPath}`);
