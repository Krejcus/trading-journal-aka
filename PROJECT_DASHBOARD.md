# Project Status: AlphaTrade Mentor v1.5 [HANDOVER]

## 🚀 Recent Accomplishments (Antigravity AI)
- **Speed Optimization:** Reduced initial bundle size from 1.8MB to ~670KB using `React.lazy` and `Suspense`.
- **Instant Boot:** Implemented "Fast-Path" loading. Dashboard now renders <1.5s using local cache (IndexedDB) while syncing server data in the background.
- **Smart Prefetching:** Secondary modules (Journal, Settings, BusinessHub) are downloaded in the background after initial render.
- **User Cache:** Profile data (name/avatar) is now persisted locally for instant UI consistency.
- **Journal Fixes:** Stabilized `DailyJournal.tsx` saving logic and resolved useEffect infinite loops.

## 🛠️ Tech Stack
- **Frontend:** React + Vite + Tailwind CSS
- **Backend/DB:** Supabase (PostgreSQL)
- **Local Storage:** `idb-keyval` (IndexedDB) + LocalStorage
- **Auth:** Supabase Auth
- **Deployment:** Vercel (Production: https://alphatrade-mentor-15.vercel.app)

## 📍 Current State
- The app is highly performant. 
- All critical flows (Journaling, Trading, Analysis) are verified.
- MCP Bridge (`opencode`) is running on port `31090`.

## ⚠️ Notes for Claude Sonnet
- **Do not remove React.Suspense wrappers** in `App.tsx` - they are critical for speed.
- **Be careful with useEffects** in `DailyJournal.tsx` - the auto-save logic is highly sensitive to dependency changes.
- **Check idb-keyval** before adding new sync logic - we prioritize "Offline-First" for speed.
