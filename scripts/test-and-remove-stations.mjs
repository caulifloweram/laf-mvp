#!/usr/bin/env node
/**
 * Test each radio station (API + built-in) and delete/hide the ones that do not connect.
 * - API stations: DELETE /api/external-stations/:id for failing streams.
 * - Built-in stations: PATCH /api/station-overrides with { streamUrl, hidden: true } so they are hidden in the client.
 *
 * Requires:
 *   API_URL   - base URL of the API (e.g. https://your-api.railway.app or http://localhost:5000)
 *   AUTH_TOKEN - Bearer token (admin) for DELETE and PATCH
 *
 * Optional:
 *   BUILT_IN_JSON - path to built-in stream URLs JSON (default: scripts/built-in-stream-urls.json)
 *   RUN_DRY      - set to 1 to only report, do not delete/hide
 *
 * Usage:
 *   node scripts/export-built-in-stream-urls.mjs   # generate built-in list first
 *   API_URL=https://... AUTH_TOKEN=... node scripts/test-and-remove-stations.mjs
 */

import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const API_URL = (process.env.API_URL || "http://localhost:5000").replace(/\/$/, "");
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
const BUILT_IN_JSON = process.env.BUILT_IN_JSON || join(__dirname, "built-in-stream-urls.json");
const DRY_RUN = process.env.RUN_DRY === "1";

async function checkStream(baseUrl, streamUrl) {
  const url = `${baseUrl}/api/stream-check?url=${encodeURIComponent(streamUrl)}`;
  const res = await fetch(url);
  if (!res.ok) return { ok: false, status: `http_${res.status}` };
  const data = await res.json();
  return { ok: !!data.ok, status: data.status || "error" };
}

async function main() {
  if (!AUTH_TOKEN && !DRY_RUN) {
    console.error("AUTH_TOKEN is required (or set RUN_DRY=1 to only report).");
    process.exit(1);
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

  if (DRY_RUN) {
    console.log("\n[DRY RUN] Would remove/hide:");
    failing.forEach((s) => console.log(`  ${s.source}: ${s.streamUrl} (${s.status})`));
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
