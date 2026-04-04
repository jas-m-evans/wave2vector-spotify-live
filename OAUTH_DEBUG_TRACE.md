# OAuth Flow Debug Trace

## What We're Logging

Comprehensive logging has been added at every critical step of the OAuth flow. When you try to connect Spotify, watch the server console for these logs in order:

### 1. **Initial Click** (Frontend)
```
[2026-04-04T...] [auth] Connect Spotify button clicked
[2026-04-04T...] [auth] Current account: user@example.com, id=...
[2026-04-04T...] [auth] Redirecting to /auth/spotify/login for account user@example.com
```

### 2. **Login Endpoint** (Server)
```
[oauth] /auth/spotify/login: sid=..., aid=..., state=...
[oauth] Redirecting to Spotify with state=...
```

The `sid` (Spotify session ID) should be created or extracted here.
The `aid` (app account ID) should exist if you're logged in.

### 3. **User Authorizes on Spotify**
(You won't see logs here - this is the Spotify website)

### 4. **Callback Received** (Server)
```
[oauth] Callback received: state=..., code=yes
[oauth] State validation: sid=..., expectedSid=..., match=true
[oauth] Token exchange successful, creating session sid=...
[oauth] Session stored: sid=..., aid=...
[oauth] Cached Spotify profile to account ...
[oauth] aid cookie set for ...
[oauth] Callback complete, redirecting to /
```

**Key checks here:**
- Does `state=` match your login endpoint log?
- Does `sid` match?
- Does token exchange succeed?
- Is `aid` set?
- Is the aid cookie being set?

### 5. **Page Reloads After Redirect** (Frontend)
```
[2026-04-04T...] [init] Page fully loaded, running initialization sequence
```

### 6. **Account Auth Check** (Frontend → Server)
**Frontend sends:**
```
[2026-04-04T...] [account] Checking app account auth
```

**Server responds:**
```
[account] /api/account/me: aid=...
[account] Active account found: email=..., id=...
```

Or if something is wrong:
```
[account] /api/account/me: aid=none
[account] No active account found for aid=none
```

**Frontend receives:**
```
[2026-04-04T...] [account] Account auth response 200
[2026-04-04T...] [auth] Account auth payload: authenticated=true
[2026-04-04T...] [auth] User logged into app account: user@example.com
```

### 7. **Spotify Auth Check** (Frontend → Server)
**Frontend sends:**
```
[2026-04-04T...] [auth] Checking Spotify auth with app account verified
```

**Server checks for `sid` cookie and Spotify session**. If Spotify is connected:
```
[2026-04-04T...] [auth] Spotify auth response 200
[2026-04-04T...] [auth] Spotify connected, checking for cached profile
```

---

## What To Look For

### If you see logs up to step 4 but not step 6:
The callback worked, but when the page reloaded, the `aid` cookie was lost.
→ Check: Is the Set-Cookie header being sent in step 4?

### If you see `aid=none` in step 6:
The cookie wasn't preserved through the redirect.
→ Check: Cookie domain, path, and sameSite settings.

### If you see `No active account found` in step 6:
The account lookup is failing even though `aid` is being sent.
→ Check: Is the account actually stored in the account store?

### If you only see up to step 2:
The redirect to Spotify is breaking.
→ Check: Is Spotify URL valid? Are env vars set?

### If you see "State validation failed" in step 4:
The CSRF state token doesn't match.
→ Check: Is the session ID from step 2 the same as in step 4?

---

## How To Run

1. Start the server:
   ```bash
   npm run build && node dist/server.js
   ```

2. Open the browser and navigate to the app

3. Log in with your app account (email/password)

4. Click "Connect Spotify"

5. Watch the server console for the logs above

6. Report what you see in the console!
