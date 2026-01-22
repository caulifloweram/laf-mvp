# 🚀 Quick Deploy to Railway (5 minutes)

## Step 1: Push to GitHub

```bash
cd /Users/alexandremarin/laf-mvp

# If not already a git repo:
git init
git add .
git commit -m "Initial commit"

# Create a new repo on GitHub (github.com/new)
# Then:
git remote add origin https://github.com/YOUR_USERNAME/laf-mvp.git
git branch -M main
git push -u origin main
```

## Step 2: Deploy on Railway

1. **Go to:** https://railway.app
2. **Sign in** with GitHub
3. **Click "New Project"**
4. **Select "Deploy from GitHub repo"**
5. **Choose** your `laf-mvp` repository

Railway will start deploying automatically!

## Step 3: Add PostgreSQL

1. In Railway dashboard, click **"+ New"**
2. Select **"Database"** → **"PostgreSQL"**
3. Wait for it to provision
4. **Copy the `DATABASE_URL`** (click on the database → Variables tab)

## Step 4: Configure Services

Railway should auto-detect your services. Configure each:

### API Service
- **Root Directory:** `packages/api`
- **Environment Variables:**
  - `DATABASE_URL` = (from PostgreSQL)
  - `JWT_SECRET` = (generate: `openssl rand -hex 32`)
  - `PORT` = `4000`
  - `RELAY_WS_URL` = (set after relay is deployed)

### Relay Service  
- **Root Directory:** `packages/relay`
- **Environment Variables:**
  - `LAF_RELAY_PORT` = `9000`

### After Relay Deploys:
1. Copy the relay service URL (e.g., `relay-production.up.railway.app`)
2. Update API service: `RELAY_WS_URL=wss://relay-production.up.railway.app`

### Broadcaster Web
- **Root Directory:** `packages/broadcaster-web`
- **Build Command:** `cd ../.. && pnpm install && cd packages/broadcaster-web && pnpm build`
- **Start Command:** `npx serve dist -p $PORT`
- **Environment Variables:**
  - `VITE_API_URL` = `https://api-production.up.railway.app`
  - `VITE_LAF_RELAY_URL` = `wss://relay-production.up.railway.app`

### Listener Web
- **Root Directory:** `packages/client-web`
- **Build Command:** `cd ../.. && pnpm install && cd packages/client-web && pnpm build`
- **Start Command:** `npx serve dist -p $PORT`
- **Environment Variables:**
  - `VITE_API_URL` = `https://api-production.up.railway.app`
  - `VITE_LAF_RELAY_URL` = `wss://relay-production.up.railway.app`

## Step 5: Run Migrations

After API is deployed:

1. Go to API service → **"Deployments"** tab
2. Click **"View Logs"**
3. Or use Railway CLI:
   ```bash
   railway login
   railway link
   railway run --service api pnpm run migrate
   ```

## Step 6: Test!

1. Open your broadcaster web URL
2. Register an account
3. Create a channel
4. Go Live
5. Open listener web URL
6. Listen! 🎵

## 🎉 Done!

Your live audio streaming platform is now online!

## 💡 Tips

- Railway provides free `.railway.app` domains
- You can add custom domains in service settings
- Check logs if something doesn't work
- Railway auto-redeploys on git push (if enabled)

## 📊 Cost

- **Free tier:** $5 credit/month (good for testing)
- **Hobby plan:** ~$10-20/month for MVP
- **Scale as needed**
