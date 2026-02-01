# Are.na Discovered Radios – Deploy List for Project Owner

This document summarizes the **Musical Expert** scrape of [are.na](https://are.na) for online radio links and how to deploy them to the LAF website.

## Discovery summary

| Metric | Value |
|--------|--------|
| **Unique links** | **656** |
| **Are.na channels** | 42 (from 45 search queries) |
| **Output file** | `scripts/are-na-radios-discovered.json` |
| **Run date** | 2026-02-01 |

Two channels failed with HTTP 504 (timeout) during content fetch; the rest were fully scraped. Social/aggregator domains (Twitter, YouTube, SoundCloud, Radio Garden, etc.) were excluded by the discovery script.

## What’s in the file

`scripts/are-na-radios-discovered.json` contains:

- **`links`**: array of `{ title, description, url, sourceChannel, sourceSlug }` for each discovered radio **website** (not necessarily the stream URL).
- **`channelsSearched`** / **`channelSlugsFetched`**: metadata about which are.na channels were queried.

Many links point to station **homepages** (e.g. `https://nts.live/`, `https://rinse.fm/`). To get **playable stream URLs** you need to resolve them (see below).

## How to get deployable station configs

1. **Resolve stream URLs** (required for playback):
   ```bash
   node scripts/resolve-are-na-streams.mjs scripts/are-na-radios-discovered.json > scripts/are-na-resolved-new.json
   ```
   - This uses the **Radio Browser API** and the script’s **manual overrides** to find a `streamUrl` for each unique domain.
   - It **skips** domains already in `EXTERNAL_STATION_CONFIGS` (so you only get **new** stations).
   - It can take **10–20+ minutes** (rate-limited API calls). Let it run to completion.

2. **Deploy the resolved list**:
   - Open `scripts/are-na-resolved-new.json`. Each object has: `name`, `description`, `websiteUrl`, `streamUrl`, `logoUrl`.
   - Either **append** these to `EXTERNAL_STATION_CONFIGS` in `packages/client-web/src/main.ts` (see `docs/CANDIDATE_STATIONS_INGEST.md`), or add them via **API** as `external_stations` (POST `/api/external-stations` with the same fields).
   - Deduplicate by `streamUrl` if you merge with other sources.

## Sample of discovered radios (by name)

A subset of the 656 links to give a sense of variety (many already in LAF; resolver will skip those and output only **new** ones):

- Manila Community Radio, N10.AS, ISO, Rinse FM, dublab, Worldwide FM, KEXP, Netil Radio, SomaFM, Sunday Brunch, NTS, DKFM/Decay FM, Radio WORM, WFMU, Fip, RADAR Lisboa, Radio Student Slovenia, Methods of Mellow, Balamii, Mushroom Radio, BFF.fm, YNot Radio, Echobox Radio, Radio Radio (Amsterdam), Radio Tempo Não Pára, Pretend Radio, DJ Full Moon, Radio Amnion, Internet Public Radio, Frisky Radio, Good Times Bad Times, Montez Press Radio, MayDay Radio, Club Night Club, Public Records, Wax Radio, Bar Part Time, KCHUNG, India Street Radio, The Lot Radio, dublab BCN, Oddity Radio, The Lake Radio, GDS.FM, FOOD New York, Datafruits.fm, Secousse, Vincent Radio, Radiorageuses, TRNSTN Radio, and many more from channels like “radio live”, “radio art”, “radio paris”, “radio resources”, etc.

## Re-running discovery

To fetch fresh data from are.na (e.g. new channels/links):

```bash
node scripts/discover-are-na-radios.mjs
```

Output is written to `scripts/are-na-radios-discovered.json` by default. Then run the resolver as in step 1 above.

## Related docs

- **Taxonomy & tagging:** `docs/MUSICAL_EXPERT_KNOWLEDGE.md`
- **Ingesting candidate stations:** `docs/CANDIDATE_STATIONS_INGEST.md`
- **Station tags index:** `scripts/build-station-tags.mjs` → `packages/client-web/public/station-tags.json`
