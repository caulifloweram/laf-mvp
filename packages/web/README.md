# LAF Web (unified launcher)

Mac-style desktop with **Broadcaster** and **Radio** icons. Double-click opens each app in a window.

## Railway deployment

1. In Railway, create a **new service** from this repo.
2. Set **Root Directory** to `packages/web`.
3. Deploy. The service will build client-web, broadcaster-web, and the launcher, then serve `dist/` (launcher at `/`, Radio at `/client/`, Broadcaster at `/broadcaster/`).
4. Your launcher URL is the service’s public URL (e.g. `https://your-web-service.up.railway.app`).

**Env vars (optional):** If your API and relay are on different hosts, set these in the Railway service so the built Radio/Broadcaster apps use them:
- `VITE_API_URL` – e.g. `https://your-api.up.railway.app`
- `VITE_LAF_RELAY_URL` – e.g. `wss://your-relay.up.railway.app`
These are applied at build time when client-web and broadcaster-web are built.
