# Task: Implementation of Web Push Notifications (Background Support)

## 1. Overview
Implementation of true background Push Notifications using VAPID keys and Vercel Cron Jobs. This will allow accurate delivery of alerts even when the app is closed or the phone is locked.

## 2. Architecture
*   **Client**: Service Worker + Push Manager API (subscribes to browser service).
*   **Database**: Store `push_subscription` JSON for each user in Supabase.
*   **Server (Vercel)**:
    *   API Route `/api/register-push`: Saves subscription to DB.
    *   API Route `/api/cron/check-alerts`: Run every minute by Vercel Cron.
    *   Logic: Checks active sessions and rule violations, sends Push via `web-push` library.

## 3. Implementation Plan

### Phase 1: VAPID Keys & Environment
1.  **VAPID Keys**: Generated (Private/Public).
    *   Public Key: Exposed to Client (env var).
    *   Private Key: Server only (env var).
2.  **Dependencies**: Install `web-push` for server-side sending.

### Phase 2: Client Side Subscription
1.  **Subscription Logic**:
    *   Convert VAPID Public Key to Uint8Array.
    *   Call `serviceWorker.pushManager.subscribe()`.
    *   Send the resulting `PushSubscription` object to our API.
2.  **Service Worker**:
    *   Ensure `push` event listener is ready to display custom title/body.

### Phase 3: Server Side (The Brain)
1.  **API Route: `/api/register-push`**:
    *   Accepts `subscription` object and `userId`.
    *   Upserts into `user_preferences` or a new table `user_push_tokens`. 
    *   *Decision*: Add `push_subscription` column (jsonb) to `user_preferences`.
2.  **API Route: `/api/cron/send-alerts`**:
    *   Fetch all users with push enabled.
    *   Check their `sessions` vs current UTC time.
    *   Send notification if Start/End/Prep conditions are met.

### Phase 4: Database Update
1.  **Schema**: Add `push_subscription` (JSONB) column to `user_preferences` table to store the complex object (endpoint, keys).

## 4. Security Note
*   The `privateKey` MUST stay on the server (Vercel Env Vars).
*   The `publicKey` is safe to be in the client bundle.

## 5. Verification
*   [ ] User clicks "Enable" -> Subscription stored in DB.
*   [ ] Manual trigger of `/api/cron/send-alerts` sends notification to locked phone.
