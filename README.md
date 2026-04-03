# Wave2Vector Spotify Live

A realtime Spotify taste compatibility app where two people join a LiveKit room, compare musical DNA, and get mutual recommendations.

This project intentionally avoids downloading or transporting raw Spotify audio. It uses Spotify metadata, now-playing state, preview URLs, cached feature vectors, and Spotify audio features.

## What this includes

- Spotify OAuth login flow
- Session + token refresh handling
- `now playing` API
- Feature-cache seeding for popular track IDs
- User taste-profile refresh from top Spotify tracks
- Live recommendations API using vector similarity
- Blended reranking (now-playing similarity + taste affinity)
- Diversity-aware reranking to reduce near-duplicate suggestions
- Explainability tags showing closest matching audio features
- Browser UI for solo flow testing
- LiveKit-backed two-user room/session mode
- Room-level compatibility scoring + grounded taste horoscope summary
- Room-level mutual recommendation ranking with fairness balancing
- Local JSON persistence for room events and snapshots

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

8. Open `http://localhost:8787`.

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

## Solo flow (unchanged)

1. Click **Connect Spotify**
2. Click **Seed famous-song feature cache**
3. Click **Refresh taste profile**
4. Play a track in Spotify and click **Refresh now playing + recs**
5. Optionally click **Start live polling**
6. Tune controls:
- `Diversity`
- `Taste weight`
- `Recommendation count`

## Two-user room flow

1. User A authenticates with Spotify.
2. User A joins/creates a room by name.
3. User B authenticates with Spotify (second browser profile/window/device).
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

Existing:

- `GET /health`
- `GET /auth/spotify/login`
- `GET /auth/spotify/callback`
- `GET /api/spotify/now-playing`
- `POST /api/library/seed-famous`
- `GET /api/library`
- `GET /api/profile`
- `POST /api/profile/taste-refresh`
- `GET /api/recommendations/live?k=5&diversity=0.2&tasteWeight=0.25`

Room mode:

- `POST /api/livekit/token`
- `POST /api/rooms/:roomName/share-state`
- `POST /api/rooms/:roomName/leave`
- `GET /api/rooms/:roomName/state`
- `GET /api/rooms/:roomName/compatibility`
- `GET /api/rooms/:roomName/mutual-recommendations?k=10`

### LiveKit token endpoint

- `POST /api/livekit/token`
- Body: `{ roomName: string, participantName: string }`
- Returns: `{ url, roomName, participantName, token }`

## Local persistence

Room mode writes local JSON files:

- `.data/livekit-events.json` (append-only event log)
- `.data/livekit-room-state.json` (latest room snapshots)

Persisted room events:

- `room_joined`
- `room_left`
- `taste_profile_shared`
- `now_playing_shared`
- `compatibility_computed`
- `mutual_recommendations_computed`

## Local 2-user test method

Use either:

- Two browser windows with separate profiles
- Two devices on the same network

Test steps:

1. Start LiveKit locally
2. Start this app
3. Authenticate both users separately
4. Join same room name from both clients
5. Confirm participants appear
6. Confirm compatibility panel and mutual recommendations update
