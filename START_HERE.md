# ✅ Setup Complete - Final Steps

I've completed most of the setup for you! Here's what's done and what you need to do:

## ✅ What's Already Done

- ✅ pnpm installed and configured
- ✅ All dependencies installed (206 packages)
- ✅ All packages built successfully
- ✅ Environment file created (`packages/api/.env`)
- ✅ Workspace configured

## 🔧 What You Need To Do

### 1. Create the Database

Open a terminal and run:

```bash
createdb laf_mvp
```

Or if that doesn't work:

```bash
psql -c "CREATE DATABASE laf_mvp;"
```

### 2. Run Migrations

```bash
cd /Users/alexandremarin/laf-mvp/packages/api
pnpm run migrate
cd ../..
```

### 3. Start All Services

Open **4 separate terminal windows** and run:

**Terminal 1 - Relay:**
```bash
cd /Users/alexandremarin/laf-mvp
pnpm dev:relay
```

**Terminal 2 - API:**
```bash
cd /Users/alexandremarin/laf-mvp
pnpm dev:api
```

**Terminal 3 - Listener Website:**
```bash
cd /Users/alexandremarin/laf-mvp
pnpm dev:client-web
```
Then open: **http://localhost:5173**

**Terminal 4 - Broadcaster Website:**
```bash
cd /Users/alexandremarin/laf-mvp
pnpm dev:broadcaster-web
```
Then open: **http://localhost:5174**

## 🎯 Test It!

1. Go to **http://localhost:5174** (broadcaster)
   - Register a new account
   - Create a channel
   - Click "Go Live" (allow microphone access)

2. Go to **http://localhost:5173** (listener)
   - You should see your channel in the list
   - Click on it
   - Click "Start Listening"
   - You should hear your microphone audio!

## 📝 Notes

- The web broadcaster currently sends raw PCM (not Opus) for MVP simplicity
- For full Opus encoding, use the Node broadcaster with a WAV file
- All services need to be running for the full experience

## 🐛 Troubleshooting

- **Database errors**: Make sure PostgreSQL is running and the database was created
- **Port conflicts**: Change ports in the respective config files
- **No audio**: Check browser permissions, make sure relay is running first
- **WebSocket errors**: Start relay before API and clients

Enjoy your live audio streaming platform! 🎵
