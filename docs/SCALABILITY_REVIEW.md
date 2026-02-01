# LAF – Scalability Review

This document summarizes scalability considerations for the LAF project (client + API) and recommended practices as the station list and traffic grow.

## Current state

- **Client:** Single bundle, ~340+ built-in stations in `EXTERNAL_STATION_CONFIGS`; grid renders all cards in one synchronous pass; stream checks use batch API with limited concurrency (4 desktop / 2 mobile).
- **API:** Express, single process; external stations and overrides from DB; stream-check and stream-check-batch endpoints; no pagination on `/api/external-stations`.

## Recommendations

### 1. **Chunked / virtualized grid render (client)**

- **Issue:** Rendering 300+ station cards synchronously blocks the main thread and can freeze the UI or delay the loading overlay from hiding.
- **Recommendation:** Render grid cards in chunks (e.g. 50–80 per chunk) using `requestAnimationFrame` between chunks so the main thread stays responsive and timers (e.g. initial load 20s) can fire.
- **Status:** Implement chunked grid render in `renderUnifiedStations()` for grid mode.

### 2. **Stream-check batch error handling (client)**

- **Issue:** If one batch request fails (network, timeout), `Promise.all` rejects and the rest of the stream-check chain stops; `streamCheckInProgress` can stay true and some URLs never get checked.
- **Recommendation:** Add `.catch()` on the batch `Promise.all`: on failure still call `runNextWave()` and `updateCheckingBanner()` so remaining batches run; optionally mark failed URLs as unknown/error.
- **Status:** Add `.catch()` in `runFullStreamCheck()` so a single failed batch does not stop the whole run.

### 3. **API: optional pagination for external stations**

- **Issue:** Returning all external stations in one response will grow with the number of stations and may become slow or large.
- **Recommendation:** Add optional query params (e.g. `?limit=100&offset=0`) to `GET /api/external-stations` and return a slice; client can either keep “fetch all” for now or adopt pagination when needed.
- **Status:** Deferred until station count or response size justifies it.

### 4. **Caching and cache invalidation**

- **Client:** Session/local storage for stream status and station snapshot is already in place; keep dedupe by `streamUrl` and TTL so cache stays valid as config grows.
- **API:** Consider short-lived caching for `GET /api/external-stations` and overrides (e.g. in-memory with TTL or cache headers) if DB or traffic grows; ensure overrides/admin updates invalidate cache.

### 5. **Station list growth**

- **Built-in list:** As `EXTERNAL_STATION_CONFIGS` grows, chunked render and batch stream checks (with error handling) keep the client scalable.
- **API list:** If most stations move to the API, built-in list can stay small (e.g. flagship stations only); client already merges API stations with built-in.

### 6. **Monitoring and limits**

- **API:** Consider request timeouts and max body size for stream-check-batch (e.g. max N URLs per request) to avoid abuse and long-running requests.
- **Client:** Batch size and concurrency are already tuned for desktop vs mobile; keep an eye on total number of simultaneous requests and back off if needed.

## Summary

- **Applied:** Chunked grid render; stream-check batch `.catch()` so one failed batch does not stop the run.
- **Deferred:** API pagination for external stations; explicit API response caching (revisit when needed).
