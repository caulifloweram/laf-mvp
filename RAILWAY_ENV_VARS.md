# Railway Environment Variables Configuration

## Your Service URLs:
- **API:** https://lafapi-production.up.railway.app
- **Relay:** wss://lafrelay-production.up.railway.app
- **Broadcaster Web:** https://lafbroadcaster-web-production.up.railway.app
- **Listener Web:** https://lafclient-web-production.up.railway.app

---

## Environment Variables to Set

### 1. API Service (`packages/api`)

Go to API service → Variables tab → Add these:

```
DATABASE_URL=<keep existing Railway-provided value>
JWT_SECRET=614377f0d5972e42e8fb39c8b39ac96702e6637f38048f8bee7cfe4de89fbbc9
PORT=4000
RELAY_WS_URL=wss://lafrelay-production.up.railway.app
CORS_ORIGIN=https://lafbroadcaster-web-production.up.railway.app,https://lafclient-web-production.up.railway.app
```

**To generate JWT_SECRET:**
```bash
openssl rand -hex 32
```
Or use any random string like: `my-super-secret-jwt-key-change-this-in-production`

---

### 2. Relay Service (`packages/relay`)

Go to Relay service → Variables tab → Add:

```
LAF_RELAY_PORT=9000
```

(Or Railway will auto-detect the port)

---

### 3. Broadcaster Web (`packages/broadcaster-web`)

Go to Broadcaster Web service → Variables tab → Add:

```
VITE_API_URL=https://lafapi-production.up.railway.app
VITE_LAF_RELAY_URL=wss://lafrelay-production.up.railway.app
```

---

### 4. Listener Web (`packages/client-web`)

Go to Listener Web service → Variables tab → Add:

```
VITE_API_URL=https://lafapi-production.up.railway.app
VITE_LAF_RELAY_URL=wss://lafrelay-production.up.railway.app
```

---

## Quick Setup Steps:

1. **API Service:**
   - Set `DATABASE_URL` (already done)
   - Set `JWT_SECRET` (generate random string)
   - Set `RELAY_WS_URL=wss://lafrelay-production.up.railway.app`

2. **Relay Service:**
   - Set `LAF_RELAY_PORT=9000` (optional, Railway handles this)

3. **Broadcaster Web:**
   - Set `VITE_API_URL=https://lafapi-production.up.railway.app`
   - Set `VITE_LAF_RELAY_URL=wss://lafrelay-production.up.railway.app`

4. **Listener Web:**
   - Set `VITE_API_URL=https://lafapi-production.up.railway.app`
   - Set `VITE_LAF_RELAY_URL=wss://lafrelay-production.up.railway.app`

---

## Test Your Deployment:

1. Open: https://lafbroadcaster-web-production.up.railway.app
2. Register an account
3. Create a channel
4. Go Live
5. Open: https://lafclient-web-production.up.railway.app
6. Listen to your stream! 🎵

---

## Troubleshooting:

- **CORS errors:** Make sure API has correct CORS settings
- **WebSocket errors:** Make sure you're using `wss://` (secure WebSocket) not `ws://`
- **Connection errors:** Check that all environment variables are set correctly
- **Build errors:** Check Railway logs for specific errors
