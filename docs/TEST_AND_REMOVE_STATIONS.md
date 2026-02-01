# Test and remove stations that do not connect

You run **two scripts on your own computer** (terminal). They call your API (e.g. on Railway); you do **not** set any variables in Railway for these scripts.

---

## Why do some working radios appear as failing?

The script uses your **API’s** `/api/stream-check` endpoint. That check runs **on the API server** (e.g. Railway), not in your browser. So:

- A stream that **works for you** on the website can **fail** in the report (e.g. different region, firewall, or the stream was slow when the script ran).
- The “failing” list is a **hint** for review—not a list of stations to hide blindly. If a station works on the website for you, you can ignore it in the report and leave it visible.

---

## Permanently remove built-in stations from code

In the **admin panel**, “Delete” on a **built-in** station only **hides** it (via API overrides); it stays in the client code. To **actually delete** built-in stations from the codebase (so they’re gone from `packages/client-web/src/main.ts`):

1. **Option A – From a file**  
   Put one stream URL per line in a text file (e.g. `scripts/stations-to-remove.txt`), then run:
   ```bash
   node scripts/remove-built-in-stations.mjs scripts/stations-to-remove.txt
   ```

2. **Option B – From the API**  
   If you’ve already hidden built-in stations in the admin panel, the script can read those and remove them from code. First run `node scripts/export-built-in-stream-urls.mjs`, then:
   ```bash
   API_URL=https://YOUR-API-URL.up.railway.app node scripts/remove-built-in-stations.mjs --from-api
   ```
   This removes from code only built-in stations that are currently **hidden** in the API.

**Dry run (no file changes):**
   ```bash
   DRY_RUN=1 node scripts/remove-built-in-stations.mjs scripts/stations-to-remove.txt
   ```
   After running for real, commit the updated `main.ts` and deploy.

---

## Step 1: Export built-in stream URLs (one-time or when client list changes)

In the project folder, in a terminal:

```bash
node scripts/export-built-in-stream-urls.mjs
```

This creates/updates `scripts/built-in-stream-urls.json`. Run again if you change built-in stations in the client.

---

## Step 2: Get your API URL (no paste into Railway)

- **Railway:** Open your Railway project → select the **API** service → **Settings** or **Deployments** → copy the **public URL** (e.g. `https://laf-mvp-api-production-xxxx.up.railway.app`). Use that as `API_URL`; **do not** add `/api` at the end.
- **Local:** If the API runs on your machine, use `http://localhost:4000` (or whatever port it uses).

You will paste this URL **only in the terminal** when you run the script (see Step 4). You do **not** put it in Railway’s environment variables for this.

---

## Step 3: Get an admin auth token (only if you want to delete/hide for real)

You need this only when you run **without** `RUN_DRY=1` (i.e. when you actually delete/hide stations).

1. Open your app in the browser (e.g. the LAF client that uses your API).
2. Sign in with an **admin** account (one whose email is in `LAF_ADMIN_EMAILS` on the API).
3. Get the JWT your app uses for API calls:
   - **Option A:** In the browser, DevTools → **Application** (or **Storage**) → **Local Storage** (or **Session Storage**) → find the key that holds the token (e.g. `token`, `jwt`, `auth`) and copy its value.
   - **Option B:** In **Network**, trigger a request that sends `Authorization: Bearer ...` and copy the token from that header.

That value is your `AUTH_TOKEN`. You paste it **only in the terminal** when you run the script (Step 4). You do **not** put it in Railway.

---

## Step 4: Run the test script in the terminal

Open a terminal in the project root (where `scripts/` is).

**4a) Dry run (only see which stations would be removed; no changes)**

Replace `https://YOUR-API-URL.up.railway.app` with your real API URL (from Step 2):

```bash
API_URL=https://YOUR-API-URL.up.railway.app RUN_DRY=1 node scripts/test-and-remove-stations.mjs
```

Example:

```bash
API_URL=https://laf-mvp-api-production-abc123.up.railway.app RUN_DRY=1 node scripts/test-and-remove-stations.mjs
```

No `AUTH_TOKEN` needed. The script will list which stations fail the stream check; it will **not** delete or hide anything.

**4b) Actually remove/hide failing stations**

Replace `https://YOUR-API-URL.up.railway.app` and `YOUR_ADMIN_JWT` with your API URL and admin token:

```bash
API_URL=https://YOUR-API-URL.up.railway.app AUTH_TOKEN=YOUR_ADMIN_JWT node scripts/test-and-remove-stations.mjs
```

Example:

```bash
API_URL=https://laf-mvp-api-production-abc123.up.railway.app AUTH_TOKEN=eyJhbGciOiJIUzI1NiIs... node scripts/test-and-remove-stations.mjs
```

This will:

- **API stations** that fail: delete them from the database.
- **Built-in stations** that fail: hide them via `station_overrides` (they stay in code but don’t show in the app).

---

## Summary

| What | Where |
|------|--------|
| **Where you run the script** | Your computer, in a terminal, in the project folder. |
| **Where you get API_URL** | Railway dashboard → API service → public URL (or localhost if running API locally). |
| **Where you use API_URL** | In the terminal: `API_URL=https://...` before `node scripts/test-and-remove-stations.mjs`. |
| **Where you get AUTH_TOKEN** | From your app after signing in as admin (local/session storage or Network header). |
| **Where you use AUTH_TOKEN** | In the terminal: `AUTH_TOKEN=...` when running without `RUN_DRY=1`. |
| **Railway env vars** | You do **not** need to add API_URL or AUTH_TOKEN to Railway for this script. |
