# Wave2Vector Spotify Live

A realtime Spotify taste compatibility app where two people join a LiveKit room, compare musical DNA, and get mutual recommendations.

This project intentionally avoids downloading or transporting raw Spotify audio. It uses Spotify metadata, now-playing state, preview URLs, cached feature vectors, and Spotify audio features.

## What this includes

- App account system (register / log in / log out)
- Spotify OAuth login flow
- Session + token refresh handling
- `now playing` API
- Feature-cache seeding for popular track IDs
- User taste-profile refresh from top Spotify tracks
- Background library sync with progress tracking
- Live recommendations API using vector similarity
- Blended reranking (now-playing similarity + taste affinity)
- Diversity-aware reranking to reduce near-duplicate suggestions
- Explainability tags showing closest matching audio features
- Browser UI for solo flow testing
- LiveKit-backed two-user room/session mode
- Room-level compatibility scoring + grounded taste horoscope summary
- Room-level mutual recommendation ranking with fairness balancing
- Room history and event log
- Local JSON persistence (dev) and Upstash Redis (production)

## Architecture note (important)

Spotify playback streams are not available as raw WAV/PCM for extraction in your app. In this repo, LiveKit is used only as a realtime room/session layer for exchanging app-level state between users.

- Spotify audio is not proxied through LiveKit
- Spotify audio is not recorded or downloaded
- Compatibility and recommendations are computed from metadata and vectors

## Quick start

1. Create a Spotify app in the Spotify Developer Dashboard.
2. Set redirect URI to `http://localhost:8787/auth/spotify/callback`.
3. Copy env file:

```bash
cp .env.example .env
```

4. Fill in `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`.
5. Keep or edit LiveKit dev defaults in `.env`:

```bash
LIVEKIT_URL=ws://127.0.0.1:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
```

6. Start a local LiveKit server in dev mode (free), for example:

```bash
docker run --rm -p 7880:7880 -p 7881:7881/tcp -e LIVEKIT_KEYS="devkey: secret" livekit/livekit-server --dev --bind 0.0.0.0
```

7. Install and run app:

```bash
npm install
npm run dev
```

8. Open `http://localhost:8787`, register an account, then connect Spotify.

## Easy testing (fast path)

Run:

```bash
npm run test:easy
```

It performs:

- Type check
- Build
- Smoke check for `/health`
- Smoke check that protected routes return `401` without auth

## Deploy to Vercel (free tier)

This app is fully compatible with Vercel using Upstash Redis for session + room persistence.

### Prerequisites

1. GitHub repo with this code pushed.
2. Vercel account (free).
3. Upstash Redis account (free tier).

### Steps

1. **Create Upstash Redis database:**
   - Go to https://console.upstash.com
   - Create a new Redis database (free tier is fine)
   - Copy `REST API URL` and `REST API Token`

2. **Deploy to Vercel:**
   - Go to https://vercel.com/new
   - Select your GitHub repo
   - In **Environment Variables**, set:
     - `SPOTIFY_CLIENT_ID` (from Spotify Dashboard)
     - `SPOTIFY_CLIENT_SECRET` (from Spotify Dashboard)
     - `SPOTIFY_REDIRECT_URI` = `https://YOUR-VERCEL-URL/auth/spotify/callback`
     - `LIVEKIT_URL` (your LiveKit server URL, e.g., LiveKit Cloud wss://...)
     - `LIVEKIT_API_KEY` (from LiveKit dashboard)
     - `LIVEKIT_API_SECRET` (from LiveKit dashboard)
     - `UPSTASH_REDIS_REST_URL` (from Upstash)
     - `UPSTASH_REDIS_REST_TOKEN` (from Upstash)
   - Click **Deploy**

3. **Update Spotify app:**
   - In Spotify Developer Dashboard, add the Vercel callback URL to your app's redirect URIs:
     `https://YOUR-VERCEL-URL/auth/spotify/callback`

4. **Test:**
   - Open your Vercel URL
   - Connect Spotify
   - Create/join a room with a friend

### Free tier limits

- Vercel: up to 100 deployments/month, always-on serverless
- Upstash Redis: 10K commands/day (sufficient for MVP testing)
- LiveKit Cloud: free tier available for testing

## Solo flow

1. Register an account and log in
2. Click **Connect Spotify**
3. Click **Seed famous-song feature cache**
4. Click **Refresh taste profile**
5. Play a track in Spotify and click **Refresh now playing + recs**
6. Optionally click **Start live polling**
7. Tune controls:
- `Diversity`
- `Taste weight`
- `Recommendation count`

## Two-user room flow

1. User A registers an account and authenticates with Spotify.
2. User A joins/creates a room by name.
3. User B registers a separate account and authenticates with Spotify (second browser profile/window/device).
4. User B joins the same room name.
5. Each user shares taste profile and optional now-playing state.
6. Once both users are present with taste profiles, room analytics populate automatically.

Room mode UI shows:

- Room status and connected participants
- Each participant's now-playing snapshot (if available)
- Compatibility score meter and similarity label
- Strong shared traits + biggest differences
- Taste horoscope summary grounded in real feature deltas
- Mutual recommendations ranked for shared appeal

## Compatibility engine (deterministic)

At minimum it computes:

- Cosine similarity between user taste vectors
- Top shared feature affinities
- Biggest disagreement features
- Optional current-track closeness if both now-playing vectors exist

It returns:

- `overallScore` (0-100)
- `similarityLabel`
- `strongestSharedTraits`
- `biggestDifferences`
- `currentTrackComparison` (optional)
- `explanation` (playful but explainable)

## Mutual recommendation engine

For a 2-user room:

- Build a joint vector from user A + B taste vectors
- Optionally blend now-playing vectors with small weight
- Score library candidates for user A, user B, and joint fit
- Apply fairness penalty so picks do not heavily favor one side
- Return ranked tracks with reason tags

Reason tags include examples like:

- `balanced fit for both`
- `shared energy`
- `similar valence`
- `bridges acousticness gap`

## API endpoints

### Auth and account

- `POST /api/account/register` — create a new app account
- `POST /api/account/login` — log in to an existing account
- `POST /api/account/logout` — log out (clears cookie)
- `GET /api/account/me` — current account info
- `GET /api/me` — current Spotify session info

### Spotify

- `GET /auth/spotify/login` — start Spotify OAuth flow
- `GET /auth/spotify/callback` — OAuth redirect target
- `GET /api/spotify/now-playing` — currently playing track

### Library and profile

- `POST /api/library/seed-famous` — seed feature cache from well-known tracks
- `GET /api/library` — list cached library tracks
- `GET /api/profile` — current taste profile
- `POST /api/profile/taste-refresh` — rebuild taste vector from top Spotify tracks
- `POST /api/sync/bootstrap` — start a full library sync
- `GET /api/sync/progress` — current sync progress

### Recommendations

- `GET /api/recommendations/live?k=5&diversity=0.2&tasteWeight=0.25` — ranked recommendations

### Rooms

- `POST /api/livekit/token` — issue a LiveKit access token
- `GET /api/rooms/active` — list active rooms
- `POST /api/rooms/:roomName/share-state` — publish taste + now-playing state to room
- `POST /api/rooms/:roomName/publish` — publish a raw event to room
- `POST /api/rooms/:roomName/leave` — leave a room
- `POST /api/rooms/:roomName/resume` — rejoin a room and restore state
- `GET /api/rooms/:roomName/state` — current room state
- `GET /api/rooms/:roomName/compatibility` — compatibility analysis for room participants
- `GET /api/rooms/:roomName/mutual-recommendations?k=10` — mutual recommendations
- `GET /api/rooms/:roomName/history` — room event history

### Utilities

- `GET /health` — server health check
- `GET /api/config/status` — environment/config readiness
- `POST /api/debug/logs` — receive client-side debug log batches
- `GET /demo` — demo mode (serves the same UI, bypasses account gate)

### LiveKit token endpoint

- `POST /api/livekit/token`
- Body: `{ roomName: string, participantName: string }`
- Returns: `{ url, roomName, participantName, token }`

## Persistence

In local development, room state is written to JSON files:

- `.data/livekit-events.json` (append-only event log)
- `.data/livekit-room-state.json` (latest room snapshots)

When `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are set (e.g. on Vercel), the app uses Upstash Redis instead of local files.

## Local 2-user test method

Use either:

- Two browser windows with separate profiles
- Two devices on the same network

Test steps:

1. Start LiveKit locally
2. Start this app
3. Register separate accounts and authenticate with Spotify for both users
4. Join the same room name from both clients
5. Confirm participants appear
6. Confirm compatibility panel and mutual recommendations update
