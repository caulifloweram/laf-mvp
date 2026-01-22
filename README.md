# LAF MVP - Low-bitrate Audio Frames Live Streaming

A live audio broadcast platform with adaptive bitrate streaming.

## Quick Start

1. **Set up Postgres database:**
   ```bash
   createdb laf_mvp
   # Or use psql:
   # psql -c "CREATE DATABASE laf_mvp;"
   ```

2. **Install dependencies:**
   ```bash
   pnpm install
   ```

3. **Set up environment variables:**
   ```bash
   cp packages/api/.env.example packages/api/.env
   # Edit packages/api/.env with your Postgres connection string
   ```

4. **Run database migrations:**
   ```bash
   cd packages/api
   pnpm run migrate
   ```

5. **Start all services:**
   - Terminal 1: `pnpm dev:relay` (WebSocket relay on port 9000)
   - Terminal 2: `pnpm dev:api` (HTTP API on port 4000)
   - Terminal 3: `pnpm dev:client-web` (Listener website on port 5173)
   - Terminal 4: `pnpm dev:broadcaster-web` (Streamer website on port 5174)

6. **Test it:**
   - Open http://localhost:5174 (streamer)
   - Login, create a channel, click "Go Live"
   - Open http://localhost:5173 (listener)
   - See your channel in the list, click to listen

## Architecture

- `packages/common` - LAF packet encode/decode
- `packages/relay` - WebSocket relay server (multi-stream)
- `packages/api` - HTTP API with Postgres (auth, channels)
- `packages/client-web` - Listener web app (Vite + Web Audio)
- `packages/broadcaster-web` - Streamer web app (Vite + mic capture)
- `packages/broadcaster` - Node.js broadcaster (WAV file fallback)
