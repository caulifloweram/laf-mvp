# LAF Broadcaster (web)

Broadcast app: go live, add your radio to LAF.

## Standalone deploy (e.g. Railway)

1. **Build:** `pnpm build`
2. **Start:** run `node scripts/write-config.cjs` then serve `dist` (e.g. `pnpm run serve`). This writes `dist/config.json` from env so the app gets API/relay/client URLs at runtime.
3. **Env vars:** set `API_URL`, `RELAY_WS_URL`, and **`CLIENT_APP_URL`** (e.g. `https://laf.up.railway.app`) so the topbar "LAF", "Live Stations", and "About" links take users back to the main site.

If Root Directory is `packages/broadcaster-web`, use start command: `node scripts/write-config.cjs && npx --yes serve dist -p $PORT` or `pnpm run serve`.
