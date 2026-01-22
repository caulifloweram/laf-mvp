# Quick Start Guide

## 🚀 Get Everything Running in 5 Minutes

### 1. Create Database
```bash
createdb laf_mvp
```

### 2. Install & Setup
```bash
cd laf-mvp
pnpm install
cp packages/api/.env.example packages/api/.env
cd packages/api && pnpm run migrate && cd ../..
```

### 3. Start Services (4 terminals)

**Terminal 1 - Relay:**
```bash
pnpm dev:relay
```

**Terminal 2 - API:**
```bash
pnpm dev:api
```

**Terminal 3 - Listener Website:**
```bash
pnpm dev:client-web
# Opens at http://localhost:5173
```

**Terminal 4 - Broadcaster Website:**
```bash
pnpm dev:broadcaster-web
# Opens at http://localhost:5174
```

### 4. Test It!

1. Go to **http://localhost:5174** (broadcaster)
   - Register/login
   - Create a channel
   - Click "Go Live" (allow mic access)

2. Go to **http://localhost:5173** (listener)
   - See your channel in the list
   - Click it, then "Start Listening"
   - You should hear audio!

## 📝 Note on Web Broadcaster

The web broadcaster currently sends raw PCM (not Opus) for MVP simplicity. For a full test with proper Opus encoding, use the Node broadcaster:

```bash
# In a 5th terminal:
cd packages/broadcaster
LAF_WAV_PATH=./input.wav \
LAF_RELAY_URL="ws://localhost:9000/?role=broadcaster&streamId=YOUR_STREAM_ID" \
pnpm dev
```

Get `YOUR_STREAM_ID` from the API after clicking "Go Live" in the web broadcaster, or check the API response.

## 🎯 What You Have

- ✅ Multi-stream relay (WebSocket)
- ✅ HTTP API with Postgres (auth, channels)
- ✅ Listener web app (channel list + LAF player with ABR)
- ✅ Broadcaster web app (mic capture + streaming)
- ✅ Node broadcaster (WAV file → Opus → LAF)

## 🔧 Troubleshooting

- **Database errors**: Make sure Postgres is running and `laf_mvp` database exists
- **Port conflicts**: Change ports in config files
- **No audio**: Check browser permissions, make sure relay is running first
- **WebSocket errors**: Start relay before API and clients
