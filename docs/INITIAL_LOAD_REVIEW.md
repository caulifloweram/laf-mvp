# LAF – Initial Load Review

This document summarizes recommendations for improving the speed and perceived performance of the initial loading process on the LAF client.

## Current flow

1. **No cache:** Show loading overlay (message: “Loading stations… This may take up to 20 seconds”), start `loadExternalStations()` (API), start `runFullStreamCheck(getBuiltInStreamUrls())` (batch stream checks).
2. **Stations ready:** When the API returns (or times out), hide the overlay, then call `renderExternalStations()` (which does `renderUnifiedStations()` + stream check).
3. **20s fallback:** A `setTimeout(20s)` hides the overlay if it was not already hidden (e.g. API hang).

## Issues addressed

### 1. **Overlay hidden before heavy render**

- **Issue:** If we rendered the full grid (340+ cards) synchronously after the API returned, the main thread could be blocked for a long time, so the 20s timeout might not fire and the overlay could stay visible for over a minute.
- **Fix:** Call `tryHideInitialLoadScreen()` as soon as we have station data (in `loadExternalStations()` success and catch paths) **before** calling `renderExternalStations()`, so the overlay disappears quickly and the 20s timer remains a fallback only.
- **Status:** Implemented.

### 2. **Chunked grid render**

- **Issue:** Building and appending 300+ DOM nodes in one synchronous loop blocks the main thread, delays first paint, and can prevent timers and other work from running.
- **Recommendation:** In grid mode, render cards in chunks (e.g. 50–80 per chunk) and use `requestAnimationFrame` between chunks so the browser can paint and handle timers (e.g. the 20s overlay timeout).
- **Status:** Implement chunked grid render in `renderUnifiedStations()` for grid mode.

### 3. **Stream-check robustness**

- **Issue:** If a batch request in `runFullStreamCheck()` fails (network error, timeout), the whole chain could stop and the “Checking stream availability” banner or cache state could get stuck.
- **Recommendation:** Add `.catch()` to the `Promise.all` in the batch loop: on failure, still advance to the next wave (`runNextWave()`) and update the banner so the rest of the URLs are checked.
- **Status:** Add `.catch()` in `runFullStreamCheck()`.

### 4. **Data tunnel and prioritization**

- **Current:** Built-in stream URLs are checked immediately via `runFullStreamCheck(getBuiltInStreamUrls())` while the API load runs; after the API returns, a full `runFullStreamCheck()` runs for any uncached URLs. This uses the 20s “tunnel” well.
- **Optional:** Prioritize the first N URLs (e.g. first 50) so “above the fold” stations get LIVE badges sooner; current batching already processes in order, so this is a possible future tweak rather than a required change.

### 5. **Mobile vs desktop**

- **Current:** Mobile uses smaller batch chunk (15), lower concurrency (2), and longer timeouts for stations and stream-check batch to avoid saturation and timeouts on slow networks.
- **Status:** Already in place; no change needed for this review.

## Summary

- **Applied:** Hide overlay before heavy render; chunked grid render; stream-check batch `.catch()` so one failed batch does not stop the run.
- **Result:** Overlay disappears as soon as station data is ready; grid appears progressively without blocking the main thread for long; stream checks continue even if individual batches fail.
