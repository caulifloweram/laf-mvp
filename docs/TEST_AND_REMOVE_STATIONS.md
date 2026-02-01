# Test and remove stations that do not connect

Two scripts let you test every radio station (API + built-in) and remove or hide the ones that fail the stream check.

## 1. Export built-in stream URLs (one-time or when client list changes)

```bash
node scripts/export-built-in-stream-urls.mjs
```

This reads `packages/client-web/src/main.ts`, extracts all `streamUrl` values from `EXTERNAL_STATION_CONFIGS`, and writes `scripts/built-in-stream-urls.json` (unique URLs). Run again after adding/editing built-in stations.

## 2. Test all stations and remove/hide failing ones

**Requirements**

- API must be running (local or deployed).
- Admin auth token for DELETE (external stations) and PATCH (station overrides).

**Dry run (report only, no changes)**

```bash
API_URL=https://your-api.railway.app RUN_DRY=1 node scripts/test-and-remove-stations.mjs
```

**Run for real (delete API stations, hide built-in via overrides)**

```bash
API_URL=https://your-api.railway.app AUTH_TOKEN=your_admin_bearer_token node scripts/test-and-remove-stations.mjs
```

**Behavior**

- Fetches all stations from `GET /api/external-stations`.
- Adds built-in stream URLs from `scripts/built-in-stream-urls.json` (if present).
- For each unique stream URL, calls `GET /api/stream-check?url=...`.
- **Failing streams**
  - **API stations** (have `id`): `DELETE /api/external-stations/:id` (removed from DB).
  - **Built-in only**: `PATCH /api/station-overrides` with `{ streamUrl, hidden: true }` (hidden in client, not removed from code).

**Env vars**

| Variable       | Required | Description |
|----------------|----------|-------------|
| `API_URL`      | Yes      | Base URL of the API (e.g. `https://your-app.railway.app` or `http://localhost:5000`). |
| `AUTH_TOKEN`   | Yes*     | Bearer token for an admin user (*not needed if `RUN_DRY=1`). |
| `BUILT_IN_JSON`| No       | Path to built-in URLs JSON (default: `scripts/built-in-stream-urls.json`). |
| `RUN_DRY`      | No       | Set to `1` to only report failing stations and not delete/hide. |

After running, only stations that pass the stream check remain visible (API ones that fail are deleted; built-in that fail are hidden via overrides).
