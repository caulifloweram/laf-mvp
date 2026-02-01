#!/usr/bin/env node
/**
 * Test each radio station (API + built-in) from the API server's network.
 * By default only REPORTS which streams failed the check; it does NOT delete/hide.
 *
 * IMPORTANT: The check runs from the API server (e.g. Railway), not from users' browsers.
 * Some streams may "fail" here but still work when users click (different IP, region, headers).
 * Use the report as a hint for manual review; only apply remove/hide if you have verified
 * a station is truly dead (e.g. offline for good).
 *
 * - API stations: DELETE /api/external-stations/:id for failing streams (only if REMOVE=1).
 * - Built-in stations: PATCH /api/station-overrides with { streamUrl, hidden: true } (only if REMOVE=1).
 *
 * Requires:
 *   API_URL - base URL of the API (e.g. https://your-api.railway.app)
 *
 * Optional:
 *   BUILT_IN_JSON - path to built-in stream URLs JSON (default: scripts/built-in-stream-urls.json)
 *   REMOVE=1     - actually delete/hide failing stations (default: 0, report only)
 *   AUTH_TOKEN   - required only when REMOVE=1 (Bearer token for admin)
 *
 * Usage:
 *   node scripts/export-built-in-stream-urls.mjs   # generate built-in list first
 *   API_URL=https://... node scripts/test-and-remove-stations.mjs                    # report only
 *   API_URL=https://... REMOVE=1 AUTH_TOKEN=... node scripts/test-and-remove-stations.mjs  # apply changes
 */

import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const API_URL = (process.env.API_URL || "http://localhost:5000").replace(/\/$/, "");
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
const BUILT_IN_JSON = process.env.BUILT_IN_JSON || join(__dirname, "built-in-stream-urls.json");
const REMOVE = process.env.REMOVE === "1";

async function checkStream(baseUrl, streamUrl) {
  const url = `${baseUrl}/api/stream-check?url=${encodeURIComponent(streamUrl)}`;
  const res = await fetch(url);
  if (!res.ok) return { ok: false, status: `http_${res.status}` };
  const data = await res.json();
  return { ok: !!data.ok, status: data.status || "error" };
}

async function main() {
  const REMOVE = process.env.REMOVE === "1";
  if (REMOVE && !AUTH_TOKEN) {
    console.error("AUTH_TOKEN is required when REMOVE=1.");
    process.exit(1);
  }
  if (!REMOVE) {
    console.log("Running in report-only mode (no delete/hide). Set REMOVE=1 and AUTH_TOKEN to apply changes.\n");
  }

  const headers = AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {};

  const stations = [];
  const apiRes = await fetch(`${API_URL}/api/external-stations`);
  const apiStations = await apiRes.json();
  if (Array.isArray(apiStations)) {
    apiStations.forEach((s) => {
      if (s.streamUrl) stations.push({ streamUrl: s.streamUrl, id: s.id, name: s.name, source: "api" });
    });
  } else {
    console.warn("API external-stations did not return an array; continuing with built-in only.");
  }

  let builtInUrls = [];
  if (existsSync(BUILT_IN_JSON)) {
    builtInUrls = JSON.parse(readFileSync(BUILT_IN_JSON, "utf8"));
    const apiStreamUrls = new Set(stations.map((s) => s.streamUrl));
    builtInUrls.forEach((url) => {
      if (typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://")) && !apiStreamUrls.has(url)) {
        stations.push({ streamUrl: url, source: "built-in" });
      }
    });
  } else {
    console.warn(`Built-in list not found: ${BUILT_IN_JSON}. Run: node scripts/export-built-in-stream-urls.mjs`);
  }

  const uniqueByUrl = new Map();
  stations.forEach((s) => {
    if (!uniqueByUrl.has(s.streamUrl)) uniqueByUrl.set(s.streamUrl, s);
    else if (s.id && !uniqueByUrl.get(s.streamUrl).id) uniqueByUrl.set(s.streamUrl, s);
  });
  const toTest = [...uniqueByUrl.values()];
  console.log(`Testing ${toTest.length} stations (${toTest.filter((s) => s.source === "api").length} API, ${toTest.filter((s) => s.source === "built-in").length} built-in)...`);

  const failing = [];
  const passing = [];
  for (let i = 0; i < toTest.length; i++) {
    const s = toTest[i];
    process.stdout.write(`  [${i + 1}/${toTest.length}] ${s.streamUrl.slice(0, 50)}... `);
    try {
      const result = await checkStream(API_URL, s.streamUrl);
      if (result.ok) {
        passing.push(s);
        console.log("OK");
      } else {
        failing.push({ ...s, status: result.status });
        console.log(`FAIL (${result.status})`);
      }
    } catch (err) {
      failing.push({ ...s, status: "error" });
      console.log("ERROR");
    }
  }

  console.log(`\nResult: ${passing.length} OK, ${failing.length} failing.`);

  if (failing.length === 0) {
    console.log("Nothing to remove.");
    return;
  }

  if (!REMOVE) {
    console.log("\n[Report only] These failed the check from the API server (may still work for users):");
    failing.forEach((s) => console.log(`  ${s.source}: ${s.streamUrl} (${s.status})`));
    console.log("\nTo actually hide/delete them, run with REMOVE=1 and AUTH_TOKEN.");
    return;
  }

  let deleted = 0;
  let hidden = 0;
  for (const s of failing) {
    if (s.source === "api" && s.id) {
      const res = await fetch(`${API_URL}/api/external-stations/${s.id}`, { method: "DELETE", headers });
      if (res.ok || res.status === 204) {
        deleted++;
        console.log(`Deleted API station ${s.id}: ${s.streamUrl}`);
      } else {
        console.error(`Failed to delete ${s.id}: ${res.status} ${await res.text()}`);
      }
    } else {
      const res = await fetch(`${API_URL}/api/station-overrides`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ streamUrl: s.streamUrl, hidden: true }),
      });
      if (res.ok) {
        hidden++;
        console.log(`Hidden (override): ${s.streamUrl}`);
      } else {
        console.error(`Failed to hide ${s.streamUrl}: ${res.status} ${await res.text()}`);
      }
    }
  }

  console.log(`\nDone. Deleted: ${deleted}, Hidden (built-in): ${hidden}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
