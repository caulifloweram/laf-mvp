# Push to GitHub - Quick Guide

## Step 1: Create GitHub Repository

1. Go to https://github.com/new
2. **Repository name:** `laf-mvp` (or any name you prefer)
3. **Description:** "Live Audio Streaming Platform with Adaptive Bitrate"
4. **Visibility:** Public or Private (your choice)
5. **DO NOT** initialize with README, .gitignore, or license (we already have these)
6. Click **"Create repository"**

## Step 2: Push to GitHub

After creating the repo, GitHub will show you commands. Use these:

```bash
cd /Users/alexandremarin/laf-mvp

# Add the remote (replace YOUR_USERNAME with your GitHub username)
git remote add origin https://github.com/YOUR_USERNAME/laf-mvp.git

# Push to GitHub
git push -u origin main
```

## Alternative: Using SSH (if you have SSH keys set up)

```bash
git remote add origin git@github.com:YOUR_USERNAME/laf-mvp.git
git push -u origin main
```

## Step 3: Verify

Go to https://github.com/YOUR_USERNAME/laf-mvp and you should see all your files!

## Next: Deploy to Railway

Once pushed to GitHub, follow `DEPLOY_RAILWAY.md` to deploy to Railway.
