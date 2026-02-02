#!/usr/bin/env node
/**
 * Resolve Underground Radio Directory stations via Radio Browser API,
 * test each stream URL, and write working stations to urd-working.json.
 *
 * Usage: node scripts/urd-resolve-and-check.mjs
 * Output: scripts/urd-working.json
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const URD_JSON = join(__dirname, "urd-stations.json");
const OUT_JSON = join(__dirname, "urd-working.json");
const RB_API = "https://de1.api.radio-browser.info";
const STREAM_CHECK_TIMEOUT_MS = 8000;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; rv:91.0) Gecko/20100101 Firefox/91.0";
const DELAY_BETWEEN_REQUESTS_MS = 400;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function checkStream(url) {
  if (!url || (!url.startsWith("http://") && !url.startsWith("https://")))
    return { ok: false, status: "invalid" };
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), STREAM_CHECK_TIMEOUT_MS);
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "Icy-MetaData": "1",
        "User-Agent": USER_AGENT,
        Accept: "audio/*,*/*;q=0.9",
      },
    });
    clearTimeout(t);
    const ok = response.ok || response.status === 200 || response.status === 206;
    return { ok: !!ok, status: ok ? "live" : "unavailable" };
  } catch (err) {
    return { ok: false, status: err?.name === "AbortError" ? "timeout" : "error" };
  }
}

async function searchStation(name) {
  const searchName = name.replace(/\s+/g, " ").trim();
  if (!searchName) return null;
  try {
    const url = `${RB_API}/json/stations/search?name=${encodeURIComponent(searchName)}&limit=8`;
    const res = await fetch(url, {
      headers: { "User-Agent": "LAF/1.0 (URD resolver)" },
    });
    if (!res.ok) return null;
    const list = await res.json();
    if (!Array.isArray(list) || list.length === 0) return null;
    const withUrl = list.filter(
      (s) => (s.url_resolved || s.url) && (s.lastcheckok === 1 || s.lastcheckok === true)
    );
    return withUrl[0] || list[0];
  } catch (err) {
    return null;
  }
}

function normalizeName(n) {
  return n
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*$/, "")
    .trim();
}

async function main() {
  if (!existsSync(URD_JSON)) {
    console.error("Missing", URD_JSON);
    process.exit(1);
  }
  const stations = JSON.parse(readFileSync(URD_JSON, "utf8"));
  if (!Array.isArray(stations) || stations.length === 0) {
    console.error("No stations in", URD_JSON);
    process.exit(1);
  }

  const working = [];
  const seenUrls = new Set();
  console.log(`Resolving and checking ${stations.length} URD stations...\n`);

  for (let i = 0; i < stations.length; i++) {
    const { name, location } = stations[i];
    const displayName = normalizeName(name);
    process.stdout.write(`[${i + 1}/${stations.length}] ${displayName} (${location}) ... `);

    const rb = await searchStation(displayName);
    await sleep(DELAY_BETWEEN_REQUESTS_MS);

    if (!rb) {
      console.log("no result");
      continue;
    }

    const streamUrl = (rb.url_resolved || rb.url || "").trim();
    if (!streamUrl || seenUrls.has(streamUrl)) {
      console.log(streamUrl ? "duplicate URL" : "no URL");
      continue;
    }

    const result = await checkStream(streamUrl);
    await sleep(200);

    if (!result.ok) {
      console.log(`FAIL (${result.status})`);
      continue;
    }

    seenUrls.add(streamUrl);
    const homepage = (rb.homepage || rb.url || "").trim() || null;
    const favicon = (rb.favicon || "").trim() || null;
    working.push({
      name: displayName,
      location: location || rb.country || "",
      streamUrl,
      websiteUrl: homepage || streamUrl,
      logoUrl: favicon || "",
      description: `From Underground Radio Directory. ${location || ""}`.trim(),
    });
    console.log("OK");
  }

  writeFileSync(OUT_JSON, JSON.stringify(working, null, 2), "utf8");
  console.log(`\nDone. ${working.length} working stations written to ${OUT_JSON}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
