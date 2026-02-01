# Candidate Stations Feed – Ingestion Guide

This document is for the **project owner** or **project continuation** agent. It describes how to ingest the curated stations from `candidate-stations-feed.json` into the LAF website.

## Source

- **File:** `docs/candidate-stations-feed.json`
- **Origin:** External list of 250 community/underground radios, analyzed by **Musical Expert**.
- **Curated subset:** 58 stations that are:
  - Relevant to LAF (community, college, eclectic, experimental, world, jazz, indie)
  - Not already in `EXTERNAL_STATION_CONFIGS` (no duplicate `streamUrl`)
  - Excluded: religious-only, pure news/talk, mainstream commercial, duplicates (e.g. Resonance FM, WFMU, WXYC, Tilos, Worldwide FM, Radio Campus Brussels, CIUT)

## Data format

Each entry in `candidate-stations-feed.json` → `stations[]` has:

| Field         | Type     | Use |
|---------------|----------|-----|
| `name`        | string   | Display name |
| `description` | string   | Short blurb (music/community/location) |
| `websiteUrl`  | string   | Homepage |
| `streamUrl`   | string   | **Unique key.** Direct audio stream |
| `logoUrl`     | string   | Optional; can be `""` (favicon can be derived later) |
| `location`    | string   | City, country or region |
| `tags`        | string[] | From taxonomy in `MUSICAL_EXPERT_KNOWLEDGE.md` |
| `group`       | string   | One of: community, eclectic, electronic, college, world, arts, etc. |

## How to push to the website

### Option A: Append to built-in list (recommended)

1. Open `packages/client-web/src/main.ts`.
2. Find the array `EXTERNAL_STATION_CONFIGS` (around line 109).
3. Before the closing `];` of that array, add each station from `candidate-stations-feed.json` → `stations` as an object in the same shape as existing entries:
   - `name`, `description`, `websiteUrl`, `streamUrl`, `logoUrl` (use `""` if empty), `location` (optional), `tags` (optional), `group` (optional).
4. **Deduplicate:** Ensure `streamUrl` is not already present in `EXTERNAL_STATION_CONFIGS` (the feed was curated to avoid this, but if you merge other sources, check again).
5. Build and deploy the client.

### Option B: Add via API (external_stations)

1. Ensure the API is running and you have an admin user (see `LAF_ADMIN_EMAILS` in API env).
2. For each station in `stations`:
   - `POST /api/external-stations` with body `{ "url": "<websiteUrl>" }` (API will resolve stream and metadata), **or**
   - `POST /api/external-stations` with body: `name`, `description`, `websiteUrl`, `streamUrl`, `logoUrl`, and optionally `location` (tags/group are not in the DB yet; you can add them to overrides or a future schema).
3. The client merges external_stations with the built-in list; no code change in `EXTERNAL_STATION_CONFIGS` needed.

### Option C: Hybrid

- Add a few “flagship” candidates to `EXTERNAL_STATION_CONFIGS` (e.g. KPFA, Sub FM, Foundation FM, 4zzz, KOOP, WEVL).
- Add the rest via API as external_stations so they can be edited or hidden without a code deploy.

## After ingestion

- **Stream checks:** The client (and API) will probe `streamUrl` for liveness; dead streams can be hidden via `station_overrides` (admin) or removed.
- **Tags/groups:** If the UI supports filtering by `group` or `tags`, the feed already provides them; merge from the JSON when building each station object (Option A) or store in overrides/DB when that schema exists.
- **Logo:** Many entries have `logoUrl: ""`. You can leave as-is or later set `logoUrl` to `websiteUrl` + `/favicon.ico` (or scrape favicon) and persist via station_overrides.

## Summary

- **Feed:** `docs/candidate-stations-feed.json` (58 curated stations).
- **Taxonomy:** `docs/MUSICAL_EXPERT_KNOWLEDGE.md` (tags and groups).
- **Ingest:** Append to `EXTERNAL_STATION_CONFIGS` (Option A) and/or add via `POST /api/external-stations` (Option B). Prefer Option A for full control and tags/group without DB changes.
