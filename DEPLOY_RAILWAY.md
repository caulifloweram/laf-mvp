# Quick Deploy to Railway

## Prerequisites
- GitHub account
- Railway account (sign up at [railway.app](https://railway.app))

## Step 1: Push to GitHub

```bash
cd /Users/alexandremarin/laf-mvp

# Initialize git if not already
git init
git add .
git commit -m "Initial commit - LAF MVP"

# Create repo on GitHub, then:
git remote add origin https://github.com/YOUR_USERNAME/laf-mvp.git
git branch -M main
git push -u origin main
```

## Step 2: Deploy to Railway

1. **Go to Railway:** https://railway.app
2. **Sign in** with GitHub
3. **New Project** → **Deploy from GitHub repo**
4. **Select** `laf-mvp` repository

Railway will auto-detect your services! But you'll need to configure them:

## Step 3: Add PostgreSQL Database

1. In Railway dashboard, click **"+ New"**
2. Select **"Database"** → **"PostgreSQL"**
3. Railway creates it automatically
4. **Copy the `DATABASE_URL`** from the database service

## Step 4: Configure API Service

1. Railway should auto-detect `packages/api`
2. If not, click **"+ New"** → **"GitHub Repo"** → select your repo
3. Set **Root Directory:** `packages/api`
4. **Environment Variables:**
   ```
   DATABASE_URL=<from PostgreSQL service>
   JWT_SECRET=<generate-random-string>
   PORT=4000
   RELAY_WS_URL=wss://<relay-service-url>
   ```
5. **Generate Domain** (Railway will give you a URL like `api-production.up.railway.app`)

## Step 5: Configure Relay Service

1. **"+ New"** → **"GitHub Repo"** → select your repo
2. **Root Directory:** `packages/relay`
3. **Environment Variables:**
   ```
   LAF_RELAY_PORT=9000
   ```
4. **Generate Domain** (e.g., `relay-production.up.railway.app`)
5. **Copy this URL** and update `RELAY_WS_URL` in API service

## Step 6: Deploy Web Apps

### Option A: Deploy on Railway (Simple)
1. **"+ New"** → **"GitHub Repo"** → select your repo
2. **Root Directory:** `packages/broadcaster-web`
3. **Build Command:** `cd ../.. && pnpm install && cd packages/broadcaster-web && pnpm build`
4. **Start Command:** `npx serve dist -p $PORT`
5. **Environment Variables:**
   ```
   VITE_API_URL=https://<api-service-url>
   VITE_LAF_RELAY_URL=wss://<relay-service-url>
   ```

Repeat for `packages/client-web`

### Option B: Deploy on Vercel/Netlify (Better for static sites)

**Vercel:**
```bash
cd packages/broadcaster-web
npm i -g vercel
vercel --prod
# Set environment variables in Vercel dashboard
```

**Netlify:**
```bash
cd packages/broadcaster-web
npm i -g netlify-cli
netlify deploy --prod
# Set environment variables in Netlify dashboard
```

## Step 7: Run Database Migrations

After API is deployed:

1. Go to API service in Railway
2. Click **"View Logs"**
3. Or use Railway CLI:
   ```bash
   railway run --service api pnpm run migrate
   ```

## Step 8: Update Environment Variables

Update all services with the correct URLs:

**API:**
- `RELAY_WS_URL=wss://relay-production.up.railway.app`

**Broadcaster Web:**
- `VITE_API_URL=https://api-production.up.railway.app`
- `VITE_LAF_RELAY_URL=wss://relay-production.up.railway.app`

**Listener Web:**
- `VITE_API_URL=https://api-production.up.railway.app`
- `VITE_LAF_RELAY_URL=wss://relay-production.up.railway.app`

## Step 9: Test!

1. Open broadcaster web URL
2. Register/login
3. Create channel
4. Go Live
5. Open listener web URL
6. Listen to your stream!

## Troubleshooting

- **WebSocket errors:** Make sure you're using `wss://` (secure WebSocket) in production
- **CORS errors:** Add your web app domains to API CORS settings
- **Database errors:** Check DATABASE_URL is correct
- **Build errors:** Check Railway logs for specific errors

## Custom Domains (Optional)

Railway allows custom domains:
1. Go to service settings
2. Click "Generate Domain" or "Add Custom Domain"
3. Update environment variables with new URLs
