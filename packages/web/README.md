# LAF Web (unified launcher)

Mac-style desktop with **Broadcaster** and **Radio** icons. Double-click opens each app in a window.

## Railway deployment

The web package needs the full monorepo to build (client-web + broadcaster-web). Use **repo root** as the service root.

**If you see `No package.json found in /`:** the Root Directory is set to `packages/web`. Clear it so it’s empty (repo root).

1. In Railway, create a **new service** from this repo.
2. Set **Root Directory** to **empty** (repo root). Leave the field blank; do **not** enter `packages/web`.
3. In the service **Settings** → **Deploy** (or **Variables**), set **Custom Start Command** to:
   ```bash
   cd packages/web && npx --yes serve dist -p $PORT
   ```
4. Deploy. The root `nixpacks.toml` runs `pnpm install && pnpm build`, which builds the web package (and thus client-web, broadcaster-web, then launcher). The start command serves `packages/web/dist/`.
5. Your launcher URL is the service’s public URL (e.g. `https://your-web-service.up.railway.app`).

**Env vars (optional):** If your API and relay are on different hosts, set these in the Railway service so the built Radio/Broadcaster apps use them:
- `VITE_API_URL` – e.g. `https://your-api.up.railway.app`
- `VITE_LAF_RELAY_URL` – e.g. `wss://your-relay.up.railway.app`
These are applied at build time when client-web and broadcaster-web are built.
