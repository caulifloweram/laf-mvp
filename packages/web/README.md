# LAF Web (unified launcher)

Mac-style desktop with **Broadcaster** and **Radio** icons. Double-click opens each app in a window.

## Railway deployment

The web package needs the full monorepo to build (client-web + broadcaster-web). Use **repo root** as the service root.

**If you see `No package.json found in /`:** the Root Directory is set to `packages/web`. Clear it so it’s empty (repo root).

1. In Railway, create a **new service** from this repo.
2. Set **Root Directory** to **empty** (repo root). Leave the field blank; do **not** enter `packages/web`.
3. **Required:** In the service **Variables**, set your API and relay URLs so Radio and Broadcaster can connect:
   - `API_URL` – e.g. `https://your-api.up.railway.app` (no trailing slash)
   - `RELAY_WS_URL` – e.g. `wss://your-relay.up.railway.app` (WebSocket URL, no trailing slash)
   At container start, these are written to `dist/config.json`; the client and broadcaster fetch it and use these URLs.
4. Deploy. The root `nixpacks.toml` runs `pnpm install && pnpm build`. The start command writes `config.json` from env, then serves `packages/web/dist/`.
5. Your launcher URL is the service’s public URL (e.g. `https://your-web-service.up.railway.app`).

**Optional:** You can also set `VITE_API_URL` and `VITE_LAF_RELAY_URL` for build-time fallbacks; runtime `config.json` (from `API_URL` and `RELAY_WS_URL`) takes precedence.
