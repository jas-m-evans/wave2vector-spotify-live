# OAuth Debugging Guide - Spotify Login Logout Issue

## Problem Summary
When clicking "Connect Spotify", you're redirected to Spotify, approve access, and then the app refreshes but logs you out of your app account. We need to figure out why the account session is being lost during the OAuth callback.

## How Logging Works Now

### 1. **Client-side logs are persisted to localStorage**
   - Every client action (`logEvent()`) is stored in `localStorage` under key `w2v_debug_logs`
   - Logs survive the OAuth redirect and page reload
   - When the page reloads after OAuth, those logs are automatically printed to the console
   - The logs are also automatically sent to the server endpoint `/api/debug/logs`

### 2. **Server-side logs go to console**
   - Every OAuth step logs detailed information
   - Check the server console while the OAuth flow happens

---

## Step-by-Step Testing

### Step 1: Start the Server with Console Visible
```bash
cd /Users/jasonevans/Projects/wave2vector-spotify-live
npm run build
node dist/server.js
```

**Open the server output** so you can see console logs in real-time. You should see something like:
```
[server] listening on http://...
```

### Step 2: Open the App in Browser

1. Navigate to the app URL
2. **Open browser DevTools** (F12 or Cmd+Option+I)
3. Click the **Console** tab
4. **Clear the console** to start fresh

### Step 3: Create/Log Into Your Account

1. Enter email and password
2. Click **Create** (or **Log In** if you already have an account)
3. See: "Welcome {email}" in the account status

### Step 4: Click "Connect Spotify"

1. Look at **server console** - you should immediately see:
   ```
   [oauth] /auth/spotify/login: sid=..., aid=..., state=...
   [oauth] Redirecting to Spotify with state=...
   ```

2. You'll be redirected to Spotify's login page

3. Log into Spotify (if needed) and click **Agree** to authorize

4. Spotify redirects back to your app

### Step 5: Check Logs on Both Sides

#### **Browser Console (After Page Reloads)**
Should show persisted logs like:
```
=== PERSISTED DEBUG LOGS (from previous OAuth flow) ===
[oauth] Callback received: state=..., code=yes
[oauth] State validation: sid=..., expectedSid=..., match=true
[oauth] Token exchange successful, creating session sid=...
[oauth] Session stored: sid=..., aid=...
[oauth] aid cookie set for ...
[oauth] Callback complete, redirecting to /
[account] /api/account/me: aid=...
[account] Active account found: email=..., id=...
[auth] Account auth payload: authenticated=true
=== END PERSISTED LOGS ===
```

#### **Server Console**
Should show matching logs:
```
[oauth] Callback received: state=..., code=yes
[oauth] State validation: sid=..., expectedSid=..., match=true
[oauth] Token exchange successful, creating session sid=...
[oauth] Session stored: sid=..., aid=...
[oauth] aid cookie set for ...
[oauth] Callback complete, redirecting to /
[account] /api/account/me: aid=...
[account] Active account found: email=..., id=...
```

---

## What to Report

### If It Works ✅
Tell us:
- What logs you see in sequence
- Whether you stay logged in

### If It Breaks ❌
**Paste both:**

1. **Full server console output** (from when you click "Connect" to page reload)
2. **Full browser console output** (the PERSISTED DEBUG LOGS section after page reload)

---

## Troubleshooting Scenarios

### Scenario 1: Logs Stop at "Token exchange successful"
**Problem:** Token exchange might be failing or SQL-related
**Check:** Look for error messages in server console like:
```
[oauth] Token exchange failed: ...
```

### Scenario 2: See "aid=none" After Callback
**Problem:** The `aid` (account ID) cookie is not being set or is being lost
**Check:** 
- Is the line `[oauth] aid cookie set for...` appearing in server console?
- If yes, is it being sent in the redirect response? (Browser Network tab)
- If no, the account lookup is failing

### Scenario 3: See "No active account found" After Callback
**Problem:** Account ID exists but account is not in the database
**Check:**
- Did the account actually get created? Try logging in manually first
- Is the email being normalized correctly?

### Scenario 4: Redirect Happens But Then Immediately Logs Out
**Problem:** The callback succeeds but account auth check fails on page reload
**Check:**
- Look for `[account] No active account found` in persisted logs
- This means `aid` cookie wasn't sent on the reload request
- Browser DevTools → Network tab → Check cookie headers on `/api/account/me` request

### Scenario 5: No Logs in Browser Console After Redirect
**Problem:** Either the callback never happened, or there's an error
**Check:**
- Did you get redirected back to the app?
- Look at browser Network tab for the callback request
- Find the `/auth/spotify/callback` request - what's the status? (200, 302, 500, etc?)

---

## Detailed Network Inspection

If you need to dig deeper, use browser DevTools Network tab:

1. **Open Network tab** before clicking "Connect Spotify"
2. Click "Connect Spotify"
3. Find these requests:
   - `POST to Spotify` (should be 302 redirect)
   - Spotify login/authorization page
   - `/auth/spotify/callback` (should be 302 redirect to `/`)
   - Page reload request to `/` (should be 200)
   - `/api/account/me` on page reload (should be 200)

4. For the callback request, check:
   - **Response Headers** → Look for `Set-Cookie: aid=...`
   - **Request Headers on /api/account/me** → Look for `Cookie: aid=...`

---

## Quick Commands (Browser Console)

Once the app loads, you can run these in the browser console:

```javascript
// Show all stored logs
showDebugLogs();

// Clear stored logs
clearDebugLogs();

// Manually send logs to server
reportDebugLogs();
```

---

## Environment Requirements

Make sure your `.env` file has:
```
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_REDIRECT_URI=http://localhost:PORT/auth/spotify/callback (or your deployed URL)
```

If any of these are missing, Spotify OAuth won't work at all.

---

## Next Steps

1. Run through Steps 1-5 above
2. **Report what happens**, especially:
   - Are you logged in after the redirect?
   - What sequence of logs do you see?
   - Where does the sequence stop?
3. Paste the full server and browser console outputs
4. We'll identify the exact breaking point!
