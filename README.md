# Wave2Vector Spotify Live (Starter Repo)

This repo is a starting implementation for Spotify-connected, real-time similarity recommendations **without downloading Spotify audio files**.

## What this starter includes

- Spotify OAuth login flow
- Session + token refresh handling
- `now playing` API
- Feature-cache seeding for popular track IDs
- User taste-profile refresh from top Spotify tracks
- Live recommendations API using vector similarity
- Blended reranking (now-playing similarity + taste affinity)
- Diversity-aware reranking to reduce near-duplicate suggestions
- Explainability tags showing closest matching audio features
- Browser UI for testing login, seeding, polling, and recommendations

## Why this architecture

Spotify playback streams are not available as raw WAV/PCM for extraction in your app. This starter uses Spotify metadata and audio features to build vectors and deliver live recommendations legally and practically.

## Quick start

1. Create a Spotify app in the Spotify Developer Dashboard.
2. Set redirect URI to `http://localhost:8787/auth/spotify/callback`.
3. Copy env file:

```bash
cp .env.example .env
```

4. Fill in `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`.
5. Install and run:

```bash
npm install
npm run dev
```

6. Open `http://localhost:8787`.

## Easy testing (fast path)

Run this one command:

```bash
npm run test:easy
```

What it does:

- Type checks the repo
- Builds the TypeScript server
- Starts the built server briefly
- Verifies `/health` works
- Verifies protected routes correctly return `401` when not logged in

This gives you a quick confidence pass before doing Spotify auth.

## Full manual flow (Spotify connected)

1. Start app: `npm run dev`
2. Open `http://localhost:8787`
3. Click **Connect Spotify**
4. Click **Seed famous-song feature cache**
5. Click **Refresh taste profile**
6. Play a track in Spotify and click **Refresh now playing + recs**
7. Optionally click **Start live polling** for auto-refresh every 4s
8. Tune recommendation behavior live:
	- **Diversity**: higher gives more varied results
	- **Taste weight**: higher leans toward your long-term profile
	- **Recommendation count**: adjusts number of returned cards

## API endpoints

- `GET /health`
- `GET /auth/spotify/login`
- `GET /auth/spotify/callback`
- `GET /api/spotify/now-playing`
- `POST /api/library/seed-famous`
- `GET /api/library`
- `GET /api/profile`
- `POST /api/profile/taste-refresh`
- `GET /api/recommendations/live?k=5&diversity=0.2&tasteWeight=0.25`

### Recommendation controls and output

- `k` (default `5`): number of recommendations
- `diversity` (default `0.2`, range `0..1`): applies MMR-style reranking
	- `0` favors pure similarity
	- `1` strongly favors dissimilarity among picks
- `tasteWeight` (default `0.25`, range `0..1`): blend weight for profile affinity

Each recommendation now includes:

- `similarity` (target-track similarity)
- `tasteSimilarity` (profile affinity, when available)
- `blendedScore` (combined score)
- `reasons` (top matching feature tags, shown in UI chips)

## Next implementation steps

- Move session/token store to Redis/Postgres
- Persist track feature cache in Postgres with pgvector
- Add background workers for feature hydration
- Build richer visualizer tied to Spotify section/beat timing
