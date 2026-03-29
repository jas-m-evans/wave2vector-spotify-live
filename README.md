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

## API endpoints

- `GET /health`
- `GET /auth/spotify/login`
- `GET /auth/spotify/callback`
- `GET /api/spotify/now-playing`
- `POST /api/library/seed-famous`
- `GET /api/library`
- `GET /api/profile`
- `POST /api/profile/taste-refresh`
- `GET /api/recommendations/live?k=5`

## Next implementation steps

- Move session/token store to Redis/Postgres
- Persist track feature cache in Postgres with pgvector
- Add novelty/diversity reranking constraints
- Add background workers for feature hydration
- Build richer visualizer tied to Spotify section/beat timing
