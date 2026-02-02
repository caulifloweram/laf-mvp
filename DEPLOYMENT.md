# Deployment Guide - LAF MVP

## Platform Comparison

### 🏆 **Recommended: Railway** (Best for MVP)
**Pros:**
- ✅ Excellent WebSocket support
- ✅ Built-in PostgreSQL
- ✅ Monorepo support (detects pnpm workspaces)
- ✅ Simple deployment from GitHub
- ✅ Free tier available ($5 credit/month)
- ✅ Automatic HTTPS
- ✅ Environment variable management
- ✅ Easy to scale

**Cons:**
- ⚠️ Can get expensive at scale
- ⚠️ Less control than VPS

**Best for:** Quick deployment, MVP, small to medium scale

---

### 🚀 **Alternative: Fly.io** (Great for WebSockets)
**Pros:**
- ✅ Excellent WebSocket support
- ✅ Global edge network
- ✅ Generous free tier
- ✅ Docker-based (more control)
- ✅ Good for real-time apps

**Cons:**
- ⚠️ Requires Docker setup
- ⚠️ More complex initial setup

**Best for:** Global distribution, real-time apps, cost-conscious

---

### 💰 **Budget Option: Render**
**Pros:**
- ✅ Free tier available
- ✅ PostgreSQL included
- ✅ Simple deployment
- ✅ WebSocket support

**Cons:**
- ⚠️ Free tier spins down after inactivity
- ⚠️ WebSocket support can be finicky
- ⚠️ Less reliable for real-time

**Best for:** Testing, very small scale

---

## Recommended Architecture

### Option 1: Railway (Easiest)
- **1 Railway project** with multiple services:
  - PostgreSQL (Railway managed)
  - API service (Node.js)
  - Relay service (Node.js)
  - Broadcaster web (Vite static)
  - Listener web (Vite static)

### Option 2: Hybrid (Railway + Vercel/Netlify)
- **Railway:** PostgreSQL + API + Relay
- **Vercel/Netlify:** Web apps (better CDN, free hosting)

---

## Step-by-Step: Railway Deployment

### 1. Prepare Repository

```bash
# Make sure everything is committed
git init
git add .
git commit -m "Initial commit"
```

### 2. Push to GitHub

```bash
# Create a new repo on GitHub, then:
git remote add origin https://github.com/YOUR_USERNAME/laf-mvp.git
git branch -M main
git push -u origin main
```

### 3. Set Up Railway

1. Go to [railway.app](https://railway.app)
2. Sign up with GitHub
3. Click "New Project" → "Deploy from GitHub repo"
4. Select your `laf-mvp` repository

### 4. Add PostgreSQL

1. In Railway dashboard, click "+ New" → "Database" → "PostgreSQL"
2. Railway will create a PostgreSQL instance
3. Copy the connection string (DATABASE_URL)

### 5. Deploy Services

Railway will auto-detect your services. You'll need to configure:

**Service 1: API**
- Root directory: `/packages/api`
- Build command: `pnpm install && pnpm build`
- Start command: `pnpm dev` (or `node dist/index.js` for production)
- Environment variables:
  - `DATABASE_URL` (from PostgreSQL service)
  - `JWT_SECRET` (generate a random string)
  - `PORT=4000`
  - `RELAY_WS_URL=wss://your-relay-service.railway.app`

**Service 2: Relay**
- Root directory: `/packages/relay`
- Build command: `pnpm install && pnpm build`
- Start command: `pnpm dev` (or `node dist/index.js`)
- Environment variables:
  - `LAF_RELAY_PORT=9000`

**Service 3: Broadcaster Web**
- Root directory: `/packages/broadcaster-web`
- Build command: `pnpm install && pnpm build`
- Start command: `pnpm preview` (or serve `dist/` folder)
- Environment variables:
  - `VITE_API_URL=https://your-api-service.railway.app`
  - `VITE_LAF_RELAY_URL=wss://your-relay-service.railway.app`

**Service 4: Listener Web**
- Root directory: `/packages/client-web`
- Build command: `pnpm install && pnpm build`
- Start command: `pnpm preview` (or serve `dist/` folder)
- Environment variables:
  - `VITE_API_URL=https://your-api-service.railway.app`
  - `VITE_LAF_RELAY_URL=wss://your-relay-service.railway.app`

### 6. Run Migrations

After API is deployed, run migrations:
```bash
# Via Railway CLI or in the service logs
cd packages/api
pnpm run migrate
```

### 7. Configure Domains

Railway provides `.railway.app` domains. You can also add custom domains.

---

## Alternative: Fly.io Deployment

### 1. Install Fly CLI
```bash
curl -L https://fly.io/install.sh | sh
```

### 2. Create Dockerfiles

You'll need Dockerfiles for each service.

### 3. Deploy
```bash
fly launch
fly postgres create
fly secrets set DATABASE_URL=...
fly deploy
```

---

## Environment Variables Reference

### API Service
```
DATABASE_URL=postgresql://...
JWT_SECRET=your-secret-key
PORT=4000
RELAY_WS_URL=wss://relay-service.railway.app
```

### Relay Service
```
LAF_RELAY_PORT=9000
```

### Broadcaster Web
```
VITE_API_URL=https://api-service.railway.app
VITE_LAF_RELAY_URL=wss://relay-service.railway.app
```

### Listener Web
```
VITE_API_URL=https://api-service.railway.app
VITE_LAF_RELAY_URL=wss://relay-service.railway.app
```

---

## Production Checklist

- [ ] Set strong `JWT_SECRET`
- [ ] Use HTTPS/WSS (Railway does this automatically)
- [ ] Set up proper CORS (if needed)
- [ ] Configure database backups
- [ ] Set up monitoring/logging
- [ ] Test WebSocket connections
- [ ] Test from different networks
- [ ] Set up custom domains (optional)

---

## Cost Estimate (Railway)

- **Free tier:** $5 credit/month
- **Hobby plan:** $5/month + usage
- **Estimated monthly cost for MVP:** $10-20/month
  - PostgreSQL: ~$5/month
  - 4 services: ~$5-15/month (depending on usage)

---

## Next Steps After Deployment

1. Test all services are accessible
2. Run database migrations
3. Test broadcaster → listener flow
4. Monitor logs for errors
5. Set up custom domains (optional)
