# Musical Expert – Knowledge Base for LAF Radio

This document is the **Musical Expert** deliverable: research format for online radio stations, analysis of existing stations on the LAF website, and a **tag + group taxonomy** for sorting and discovery. It is written so the agent **"project continuation"** can:

1. **Upload new stations** using the same schema and conventions.
2. **Apply tags and groups** to existing and new stations for filtering/sorting on the website.

---

## 1. Format for Research & Upload (Agent-Friendly)

### 1.1 Single station (built-in or external_stations)

Use this shape. Every field except `streamUrl` can be derived or optional; `streamUrl` is the **unique key** for overrides and deduplication.

```json
{
  "name": "Station Display Name",
  "description": "One or two sentences: music focus, community, location, vibe.",
  "websiteUrl": "https://example.com/",
  "streamUrl": "https://example.com/stream",
  "logoUrl": "https://example.com/favicon.ico",
  "location": "City, Country or Region",
  "lat": 52.52,
  "lng": 13.405,
  "tags": ["electronic", "community", "freeform"],
  "group": "community"
}
```

**Field rules:**

| Field        | Required | Notes |
|-------------|----------|--------|
| `name`      | Yes      | Display name; keep concise. |
| `description` | Yes*   | Music genres/styles, community, location. *Can be empty string. |
| `websiteUrl`| Yes      | Homepage. |
| `streamUrl` | Yes      | **Unique key.** Direct audio stream (e.g. .mp3, .aac, /stream). |
| `logoUrl`   | No       | Favicon or square logo; can be `""`. |
| `location`  | No       | Human-readable place (e.g. "Berlin, Germany", "Online"). |
| `lat` / `lng` | No    | Numbers for map; use only if location is a real place. |
| `tags`      | No       | Array of strings from the **Tag vocabulary** below. |
| `group`     | No       | One string from the **Groups** list below. |

**Where this is used:**

- **Built-in list:** `packages/client-web/src/main.ts` → `EXTERNAL_STATION_CONFIGS`. Each entry is `ExternalStationConfig` (no `tags`/`group` in code yet; see section 3 for adding them).
- **DB – external_stations:** `name`, `description`, `website_url`, `stream_url`, `logo_url`, `location`, `lat`, `lng`. No `tags`/`group` columns yet.
- **DB – station_overrides:** keyed by `stream_url`; can override name, description, website_url, logo_url, location, lat, lng, hidden.

To add a station, either append to `EXTERNAL_STATION_CONFIGS` (with optional `tags`/`group` when supported) or insert into `external_stations` via API; use `station_overrides` to fix metadata for any station by `streamUrl`.

### 1.2 Multi-channel station (e.g. SomaFM, NTS, KEXP)

Use one parent object with `channels`:

```json
{
  "name": "SomaFM",
  "description": "Listener-supported, commercial-free internet radio. Multiple channels.",
  "websiteUrl": "http://soma.fm/",
  "streamUrl": "https://ice5.somafm.com/live-128-mp3",
  "logoUrl": "https://somafm.com/img/somafm-logo-square.png",
  "location": "San Francisco, USA",
  "lat": 37.7749,
  "lng": -122.4194,
  "tags": ["electronic", "ambient", "eclectic", "community"],
  "group": "eclectic",
  "channels": [
    { "name": "Groove Salad", "streamUrl": "https://ice5.somafm.com/groovesalad-128-mp3" },
    { "name": "Drone Zone", "streamUrl": "https://ice5.somafm.com/dronezone-128-mp3" }
  ]
}
```

The **first** `streamUrl` (or first channel) is typically the “main” stream for live checks and overrides. Tags and group apply to the whole station.

### 1.3 Researched station (for human or agent upload)

When researching a new station, fill this and then add to built-in config or DB:

- **Genres/styles:** From the station’s own wording + listening (e.g. “electronic, dub, experimental”).
- **Location:** City/country or “Online” / “International”.
- **Community/format:** e.g. “community”, “freeform”, “arts”, “college”.
- **Tags:** Pick from the Tag vocabulary (section 2).
- **Group:** Pick one from Groups (section 2).

---

## 2. Tag & Group Taxonomy

### 2.1 Tags (multi-select per station)

Use lowercase, no spaces; multiple tags per station.

**Genre / style**

- `ambient` – ambient, drone, atmospheric
- `electronic` – electronic music broadly (house, techno, IDM, etc.)
- `techno` – techno
- `house` – house, deep house, tech house
- `dub` – dub, dubstep, reggae-dub
- `experimental` – avant-garde, noise, sound art, leftfield
- `freeform` – freeform, no fixed genre
- `jazz` – jazz, nu-jazz, jazz-funk
- `soul` – soul, R&B, funk
- `hiphop` – hip-hop, rap
- `rock` – rock, indie, alternative, post-punk
- `folk` – folk, acoustic
- `world` – world music, global
- `classical` – classical, modern classical
- `metal` – metal, heavy
- `punk` – punk, post-punk, hardcore
- `disco` – disco, boogie
- `dance` – dance floor oriented (generic)
- `eclectic` – mixed genres, variety
- `shoegaze` – shoegaze, dream pop
- `darkwave` – darkwave, EBM, gothic, industrial
- `vaporwave` – vaporwave, synth

**Format / context**

- `community` – community / non-commercial local
- `college` – college / university radio
- `arts` – arts, culture, artist-run
- `feminist` – feminist, queer, LGBTQ+
- `talk` – talk, discussion, non-music
- `podcast` – podcast-style shows

**Mood / vibe (optional)**

- `chill` – chill, lounge, mellow
- `underground` – underground, DIY, non-mainstream

### 2.2 Groups (single-select per station)

Use for **sorting/filtering** on the site (e.g. tabs or filters). One group per station.

- `community` – Community / non-commercial local radio
- `eclectic` – Multi-genre / freeform / variety
- `electronic` – Electronic-focused (house, techno, ambient, etc.)
- `experimental` – Experimental, sound art, avant-garde
- `arts` – Arts & culture, artist-run
- `college` – College / university radio
- `world` – World music / global focus
- `talk` – Talk / discussion
- `other` – Anything that doesn’t fit above

---

## 3. Existing Stations – Location, Description & Suggested Tags/Groups

Below is a **curated subset** of the current built-in list with location, short description summary, and suggested **tags** and **group** from the taxonomy above. The full list lives in `packages/client-web/src/main.ts` → `EXTERNAL_STATION_CONFIGS`.

**How to use:**  
- Implement a **tags** and **group** field (e.g. in `ExternalStationConfig` and in DB or a separate JSON keyed by `streamUrl`).  
- Use this table to backfill: match by `streamUrl` (or name) and set `tags` and `group`.

| Station (name) | Location | Description summary | Suggested tags | Group |
|----------------|----------|---------------------|----------------|-------|
| Refuge Worldwide | Berlin, Germany | Community, music & issues | electronic, community, eclectic | community |
| Mutant Radio | Worldwide | Experimental, electronic, folk | experimental, electronic, folk, eclectic | experimental |
| Radio 80000 | Munich, Germany | Non-commercial, music, dialogue | eclectic, community | community |
| KEXP 90.3 FM | Seattle, USA | Listener-supported, variety | rock, indie, electronic, eclectic, community | eclectic |
| SomaFM | San Francisco, USA | Listener-supported, many channels | electronic, ambient, eclectic, community | eclectic |
| WFMU | Jersey City, USA | Freeform | freeform, eclectic, community | eclectic |
| NTS Radio | London, UK | Two channels, 24/7 | electronic, eclectic, community | eclectic |
| LYL Radio | Lyon, France | Independent, multi-city | electronic, eclectic, community | community |
| Noods Radio | Bristol, UK | Electronic, experimental, dub | electronic, dub, experimental | electronic |
| Veneno | São Paulo, Brazil | New music, electronic, Brazilian, house, techno | electronic, house, techno, world | electronic |
| Kiosk Radio | Brussels, Belgium | 24/7 from kiosk, eclectic | electronic, eclectic, community | community |
| KCHUNG Radio | Los Angeles, USA | Community, Chinatown | community, eclectic | community |
| Tikka Radio | Tokyo, Japan | Online radio | eclectic | other |
| WOBC Chameleon Radio | Oberlin, USA | Student freeform | college, freeform | college |
| Particle FM | San Diego, USA | DIY, underrepresented artists | electronic, community, eclectic | community |
| Hope St Radio | Melbourne, Australia | Community, wine bar | community, eclectic | community |
| Netil Radio | London, UK | Community, Hackney | electronic, community | community |
| Tsubaki FM | Tokyo, Japan | Funk, jazz, soul, electronic, disco, world | jazz, soul, electronic, disco, world | eclectic |
| Radio Nopal | Online | Community, eclectic | community, eclectic | community |
| Good Times Bad Times | Online | Community | community, eclectic | community |
| Radio Robida | Slovenia | Ambient, programme, walkie | ambient, experimental, community | experimental |
| Yamakan Palestine | Bethlehem, Palestine | Palestine | community, world | community |
| Radio Centraal | Antwerp, Belgium | Non-commercial, music, poetry, film | eclectic, community, arts | community |
| Area 3000 | Melbourne, Australia | Underground, DJ sets, podcasts | electronic, community | electronic |
| Cashmere Radio | Berlin, Germany | Experimental, 88.4 FM | experimental, electronic, ambient | experimental |
| Radio Campus Brussels | Brussels, Belgium | Student, jazz, alternative, rock, electronic | jazz, rock, electronic, college | college |
| Black Rhino Radio | Online | Electronic, reggae, dub, techno, jazz, hip hop | electronic, dub, jazz, hiphop | electronic |
| Radio Aparat | Belgrade, Serbia | Guitar, electronics, indie | rock, electronic, indie | eclectic |
| dublab | Los Angeles, USA | Experimental electronica, jazz funk, indie, hip-hop, dub | experimental, electronic, jazz, hiphop, dub | eclectic |
| RUKH | Odesa, Ukraine | DIY, alternative, experimental | experimental, community | experimental |
| Radio Helsinki | Graz, Austria | Community, non-commercial | community, eclectic | community |
| HKCR | Hong Kong | Community, creators, musicians | community, eclectic | community |
| Radio AlHara | Bethlehem, Palestine | Palestinian community, solidarity | community, world, experimental | community |
| The Lake Radio | Copenhagen, Denmark | Experimental, avant-garde, sound art | experimental, arts | experimental |
| aNONradio | USA | SDF, eclectic, experimental | experimental, community, eclectic | experimental |
| DFM RTV INT | Amsterdam, Netherlands | Artist-run, experimental, electronic | experimental, electronic | experimental |
| CROP Radio | Manchester, UK | Underground, variety | electronic, community, eclectic | community |
| Echo Park Radio | Los Angeles, USA | Community, eclectic, underground | community, eclectic | community |
| Resonance FM | London, UK | Arts, 104.4 FM, experimental | arts, experimental, community | arts |
| Violeta Radio | Mexico City, Mexico | Feminist, community, 106.1 FM | feminist, community | community |
| Fip | France | Jazz, Reggae, Rock, Electro, Soul (Radio France) | jazz, soul, rock, electronic, eclectic | eclectic |
| Rinse FM | London, UK | Urban music, 20 years | electronic, hiphop, community | electronic |
| Worldwide FM | Global | Award-winning, global audience | electronic, world, eclectic | eclectic |
| DKFM Shoegaze | Online | Shoegaze | shoegaze, rock | eclectic |
| Radio WORM | Rotterdam, Netherlands | Culture, arts | arts, experimental, community | arts |
| Balamii | London, UK | Underground music first | electronic, underground | electronic |
| The Lot Radio | NYC, USA | 24/7 from shipping container, varied | electronic, eclectic, community | community |
| datafruits.fm | Online | Eclectic, wacky | eclectic, electronic | eclectic |
| CHIRP Radio | Chicago, USA | Listener-supported, music & arts | rock, indie, community | community |
| BFF.fm | San Francisco, USA | Community, emerging artists | community, eclectic | community |
| Movement.radio | Athens, Greece | Ambient, bass, electro, experimental, hip-hop, jazz | electronic, experimental, jazz, hiphop, ambient | electronic |
| India Street Radio | Online | Balearic, jazz-funk, vinyl | electronic, jazz, world | eclectic |
| Public Records | NYC, USA | Community, response to current state | community, electronic | community |
| Wax Radio | Brooklyn, USA | Wax Studios community | community, electronic | community |
| Lower Grand Radio | Oakland, USA | Live and recorded, no set schedule | community, eclectic | community |
| sfSoundRadio | San Francisco, USA | New music, Bay Area | experimental, classical, arts | experimental |
| Moon Glow Radio | Los Angeles, USA | DIY, BIPOC, marginalized voices | community, eclectic | community |
| Tin Can Radio | UK | Uncurated, poetry, art, music | experimental, arts, eclectic | experimental |
| Mountain Town Radio | Ellijay, Georgia, USA | Local, garage rock, blues, jazz, rockabilly | rock, jazz, blues | eclectic |
| Ambient Flo | Online | 24hr ambient, deep relaxation | ambient, chill | electronic |
| Manila Community Radio | Manila, Philippines | Independent, not-for-profit, community | community, eclectic | community |
| ISO | Toronto, Canada | Underground music, untold stories | electronic, community, eclectic | community |
| N10.AS | Online | World wide wadio | eclectic | other |
| dublab bcn | Barcelona, Spain | dublab Barcelona | electronic, experimental | eclectic |
| RADAR 97.8 FM | Lisbon, Portugal | Observatório RADAR | community, eclectic | community |
| Radio Amnion | Online | Sonic transmissions, care, oceanic | experimental, ambient, community | experimental |
| Internet Public Radio | Guadalajara / Latin America / Europe | Independent cultural platform | world, community, eclectic | world |
| Frisky Radio | Online | Electronic, DJ mixes | electronic, dance | electronic |
| Montez Press Radio | Online | Archive, reading, poetry, sounded word | arts, talk, experimental | arts |
| Echobox Radio | Online | DIY, quality | electronic, community | community |
| Radio Tempo Não Pára | Amsterdam, Netherlands | Independent, guest mixes, upcoming artists | electronic, community | community |
| Pretend Radio | Online | Cargo | eclectic | other |
| Secousse | France | Brothers And Sisters | eclectic | other |
| RADIORAGEUSES | France | Feminist, gouines, trans, femmes | feminist, community, talk | community |
| TRNSTN RADIO | France | Création, rencontre, expérimentation | experimental, arts, community | experimental |
| IDA Radio | Tallinn & Helsinki | Online community radio | community, eclectic | community |
| Ola Radio | France | Musiques électroniques, scène locale | electronic, community | electronic |
| onoffon radio | Online | Handmade online radio | experimental, eclectic | experimental |

*(Many more stations exist in `EXTERNAL_STATION_CONFIGS`; the same taxonomy can be applied by parsing `name`/`description`/`location` and optionally listening to the stream.)*

---

## 4. Implementation Notes for "Project Continuation"

1. **Add tags and group to the data model**  
   - Option A: Add `tags: string[]` and `group: string` to `ExternalStationConfig` in `packages/client-web/src/main.ts` and to the API responses for external_stations and station_overrides.  
   - Option B: Keep a separate JSON file (e.g. `packages/client-web/src/station-tags.json`) keyed by `streamUrl` with `{ tags: string[], group: string }`, and merge at runtime.

2. **Backfill from this document**  
   - Use the table in section 3 (and extend it for the rest of `EXTERNAL_STATION_CONFIGS`) to populate tags and group per station.

3. **UI for sorting**  
   - Filter or sort by `group` (e.g. tabs: Community, Eclectic, Electronic, Experimental, Arts, College, World, Talk, Other).  
   - Optional: filter by one or more `tags`.

4. **New stations**  
   - When adding a station (built-in or via API), always set `tags` and `group` from the vocabularies in section 2.

5. **Resolved-stations.json**  
   - `scripts/resolved-stations.json` is output from Are.na + resolution scripts. It can be used as a **source for research** and for bulk-adding stations; before upload, enrich each entry with `tags` and `group` from this taxonomy.

6. **Candidate stations feed (external list)**  
   - `docs/candidate-stations-feed.json` is a curated subset of an external list of 250 community/underground radios. It contains stations deemed relevant to LAF (community, college, eclectic, world, etc.) with no duplicates of the built-in list. **Project owner / continuation agent:** see `docs/CANDIDATE_STATIONS_INGEST.md` for how to push these to the website (append to `EXTERNAL_STATION_CONFIGS` or add via API).

7. **Complete group/tags indexing**  
   - **Every** built-in station is indexed to at least one **group** (and optional **tags**) via `packages/client-web/public/station-tags.json`. The client fetches `/station-tags.json` and uses it as fallback when a station config has no `group`/`tags`.  
   - To **regenerate** the full index from `EXTERNAL_STATION_CONFIGS`: run `node scripts/build-station-tags.mjs`. The script parses `packages/client-web/src/main.ts`, derives group and tags from each station’s **name** and **description** (keyword-based), and writes one entry per stream URL (including all channel URLs) to `packages/client-web/public/station-tags.json`.  
   - Groups used: `community`, `eclectic`, `electronic`, `experimental`, `arts`, `college`, `world`, `talk`, `other`. Each station gets exactly one group; tags can be multiple.

---

## 5. Summary

- **Upload format:** Section 1 (JSON shape + field rules).  
- **Tag vocabulary:** Section 2.1 (multi-select, lowercase).  
- **Groups:** Section 2.2 (single-select for sorting).  
- **Existing stations:** Section 3 (sample with suggested tags/group; extend to full list).  
- **Implementation:** Section 4 (data model, backfill, UI, new stations, resolved-stations).

The Musical Expert role is to keep this document and the tag/group taxonomy updated as new stations are researched and added, so the website can sort and filter radio by genre, style, and context in a consistent way.
