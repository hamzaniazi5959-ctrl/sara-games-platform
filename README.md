# Sara Games Platform — Standalone Deploy

Public deployment of the Sara Games Platform (games + social + marketplace).

## What's included

- `server.mjs` — Standalone Bun server (no Hatch runtime dependency)
- `actions.js` — Compiled platform actions (17 originals + `downloadGame`)
- `public/` — Built React client (static)
- `data/` — SQLite database + blob storage (seeded with 49 games)
- `Dockerfile` / `render.yaml` — Render.com deployment config

## Auth model (Khan's GameJolt/itch.io design)

**Public (no login):** browse catalog, play free games, view posts/pics/videos, view profiles
**Login required:** download games (`downloadGame` action), upload games/posts,
like/comment, buying/selling, creator dashboard

## Deploy to Render (free tier)

### Option A: Via Render Dashboard (browser)
1. Push this folder to a GitHub repo
2. Go to https://dashboard.render.com → New → Web Service
3. Connect the repo, select Docker runtime
4. Free plan, health check path: `/health`
5. Deploy — Render builds the Dockerfile and starts `bun server.mjs`

### Option B: Via render.yaml (Infrastructure as Code)
1. Push this folder (including `render.yaml`) to GitHub
2. Render Dashboard → New → Blueprint → connect repo
3. It reads `render.yaml` and creates the free web service

## Important notes

- **Ephemeral storage:** Render free tier has no persistent disk. `data/app.db`
  and `data/blobs/` reset on redeploy/restart. The server **auto-bootstraps**
  the 49-game seed catalog on startup when the games table is empty.
  User accounts and uploads are lost on restart — for production persistence,
  migrate to Supabase Postgres (free tier) later.
- **First boot** takes ~30s (Bun install + seed bootstrap fetches thumbnails).
- Health check: `GET /health` → `{"ok":true,"actions":18}`

## Local run

```bash
cd sara-games-deploy
bun install
bun server.mjs
# → http://localhost:3000
```

## API

- `POST /actions` with `{"action": "<name>", "args": {...}}`
  → `{"data": ...}` or `{"error": "..."}`
- `GET /blobs/<key>` → blob file
- `GET /health` → status
