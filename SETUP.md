# Setup Instructions

## Prerequisites

1. **PostgreSQL** - Make sure PostgreSQL is running locally
2. **Node.js** - v18 or higher
3. **pnpm** - Install with `npm install -g pnpm`

## Step 1: Create Database

```bash
createdb laf_mvp
# Or using psql:
# psql -c "CREATE DATABASE laf_mvp;"
```

## Step 2: Install Dependencies

```bash
cd laf-mvp
pnpm install
```

## Step 3: Configure API

Copy the example env file and edit if needed:

```bash
cp packages/api/.env.example packages/api/.env
```

Edit `packages/api/.env` and set your database URL:
```
DATABASE_URL=postgresql://localhost:5432/laf_mvp
JWT_SECRET=your-secret-key-change-this
PORT=4000
RELAY_WS_URL=ws://localhost:9000
```

## Step 4: Run Database Migrations

```bash
cd packages/api
pnpm run migrate
```

This will create the necessary tables (users, channels, streams).

## Step 5: Start All Services

Open **4 terminal windows**:

### Terminal 1: Relay Server
```bash
cd laf-mvp
pnpm dev:relay
```
Should see: `🚀 Multi-stream relay listening on ws://localhost:9000`

### Terminal 2: API Server
```bash
cd laf-mvp
pnpm dev:api
```
Should see: `🌐 API server listening on http://localhost:4000`

### Terminal 3: Listener Website
```bash
cd laf-mvp
pnpm dev:client-web
```
Opens at: `http://localhost:5173`

### Terminal 4: Broadcaster Website
```bash
cd laf-mvp
pnpm dev:broadcaster-web
```
Opens at: `http://localhost:5174`

## Step 6: Test It!

1. **Open broadcaster site**: http://localhost:5174
   - Register a new account (or login)
   - Create a channel
   - Click "Go Live" (allow microphone access)
   - You should see "🔴 LIVE - Broadcasting..."

2. **Open listener site**: http://localhost:5173
   - You should see your channel in the list
   - Click on it
   - Click "Start Listening"
   - You should hear your microphone audio!

## Troubleshooting

- **Database connection errors**: Make sure PostgreSQL is running and the database exists
- **Port already in use**: Change ports in the respective config files
- **WebSocket connection failed**: Make sure the relay is running first
- **No audio**: Check browser permissions for microphone/audio

## Next Steps

- The broadcaster currently sends raw PCM (not real Opus). For production, integrate a WASM Opus encoder.
- Add multi-tier encoding in the broadcaster
- Improve error handling and reconnection logic
- Add chat, recording, etc.
