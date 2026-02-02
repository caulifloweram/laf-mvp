#!/usr/bin/env node
/**
 * Check built-in stream URLs by direct fetch (no API/DB needed).
 * Uses same timeout and headers as API stream-check. Writes failing URLs to stdout and to a JSON file.
 *
 * Usage:
 *   node scripts/export-built-in-stream-urls.mjs   # first
 *   node scripts/check-built-in-streams-standalone.mjs
 *
 * Output: failing list to stdout and scripts/built-in-stream-failures.json
 */

import { readFileSync, existsSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILT_IN_JSON = join(__dirname, "built-in-stream-urls.json");
const FAILURES_JSON = join(__dirname, "built-in-stream-failures.json");
const TIMEOUT_MS = 8000;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; rv:91.0) Gecko/20100101 Firefox/91.0";

async function checkStream(url) {
  if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
    return { ok: false, status: "invalid_url" };
  }
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "Icy-MetaData": "1",
        "User-Agent": USER_AGENT,
        "Accept": "audio/*,*/*;q=0.9",
      },
    });
    clearTimeout(t);
    const ok = response.ok || response.status === 200 || response.status === 206;
    return { ok: !!ok, status: ok ? "live" : "unavailable" };
  } catch (err) {
    const status = err instanceof Error && err.name === "AbortError" ? "timeout" : "error";
    return { ok: false, status };
  }
}

async function main() {
  if (!existsSync(BUILT_IN_JSON)) {
    console.error(`Run first: node scripts/export-built-in-stream-urls.mjs`);
    process.exit(1);
  }
  const urls = JSON.parse(readFileSync(BUILT_IN_JSON, "utf8"));
  if (!Array.isArray(urls) || urls.length === 0) {
    console.log("No built-in stream URLs to check.");
    return;
  }
  console.log(`Checking ${urls.length} built-in stream URLs (timeout ${TIMEOUT_MS}ms)...\n`);

  const failing = [];
  const passing = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    if (typeof url !== "string") continue;
    process.stdout.write(`  [${i + 1}/${urls.length}] ${url.slice(0, 55)}... `);
    try {
      const result = await checkStream(url);
      if (result.ok) {
        passing.push(url);
        console.log("OK");
      } else {
        failing.push({ url, status: result.status });
        console.log(`FAIL (${result.status})`);
      }
    } catch (err) {
      failing.push({ url, status: "error" });
      console.log("ERROR");
    }
  }

  console.log(`\nResult: ${passing.length} OK, ${failing.length} failing.`);

  if (failing.length > 0) {
    writeFileSync(FAILURES_JSON, JSON.stringify(failing, null, 2), "utf8");
    console.log(`\nFailing URLs written to ${FAILURES_JSON}`);
    console.log("\nFailing streams:");
    failing.forEach(({ url, status }) => console.log(`  ${status}: ${url}`));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
