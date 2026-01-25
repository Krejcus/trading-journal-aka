# Task: Implementation of Alpha Guardian System

## 1. Overview
Implementation of a discipline enforcement system called "Alpha Guardian". This includes session-based notifications, strict entry blockers (preparations), visual alerts on the dashboard, and a "Debt Collector" for missing audits.

## 2. Requirements & UI/UX Decisions
*   **Notifications**: Direct to phone via PWA/Web Push.
*   **Strict Mode**: Red warning window (overlay) blocking trade entry if preparation is missing.
*   **Dashboard Visuals**: "Danger Strips" (animated high-contrast banners) for critical states.
*   **Morning Wake Up Debt**: Confirmation that the previous day's audit is completed.

## 3. Technical Implementation Plan

### Phase 1: Core Logic & Calculations
1.  **Guardian Utility**: Create `utils/guardianLogic.ts` to:
    *   Calculate current session status (Active, Starting Soon, Ending).
    *   Check if `DailyPrep` is completed for the current session.
    *   Check if `DailyReview` from the last active trading day is missing.
2.  **State Management**: Update `App.tsx` to handle the "active alert" state.

### Phase 2: Notification Infrastructure
1.  **Web Push Registration**: Implement logic in `App.tsx` to:
    *   Check for notification permissions.
    *   Subscribe to Push Manager (VAPID).
    *   Save token to Supabase `user_preferences`.
2.  **Service Worker Update**: Enhance `public/service-worker.js` to handle background alerts if possible.

### Phase 3: UI Enforcement (The "Guardian")
1.  **GuardianOverlay Component**:
    *   Fullscreen red overlay with SVG animations.
    *   Aggressive typography: "ALPHA GUARDIAN: PŘÍPRAVA CHYBÍ".
    *   Quick-link to Journal to complete preparation.
2.  **DashboardStrips Component**:
    *   CSS-animated "Caution" tape style strips (Black/Red, Yellow/Black).
    *   Triggered when `morningPrepAlertCritical` is active and prep is missing.
3.  **DebtCollectorModal**:
    *   Information about missing audit from yesterday.
    *   Prevents full dashboard access until acknowledged or audit is started.

### Phase 4: Integration
1.  **Dashboard Integration**: Add `DashboardStrips` to the main layout.
2.  **ManualTradeForm Integration**: Add `GuardianOverlay` check when clicking "Add Trade".
3.  **App Startup**: Trigger `DebtCollector` if session just started.

## 4. Verification Criteria
*   [ ] Toggle "Strict Mode" and try adding a trade without prep -> Blocks entry.
*   [ ] Critical alert time reached without prep -> Dashboard gets animated strips.
*   [ ] Startup check -> If review is missing, user is notified.
*   [ ] Notification permission request works on mobile/PWA.
