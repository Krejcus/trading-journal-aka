# Plán ladění rychlosti: AlphaTrade Mentor v1.5 [REFINEMENT]

## 🎯 Cíl
1. Zobrazit jméno a fotku uživatele okamžitě při startu (z cache).
2. Minimalizovat čekání při přepnutí na Deník pomocí "přednačítání" (prefetching).

## 🏗️ Strategie

### 1. Perzistence profilu (User Cache)
Uživatelský profil se nyní stahuje pouze ze serveru. Do `storageService.ts` přidáme lokalní ukládání profilu do IndexedDB.
- **Změna:** `storageService.getUser()` bude nejdříve kontrolovat cache.
- **Změna:** `storageService.saveUser()` bude aktualizovat cache i server.

### 2. Přednačítání modulů (Smart Prefetching)
Lazy loading šetří start, ale zpomaluje navigaci. Přidáme mechanismus, který začne stahovat těžké moduly (Deník, Nastavení) na pozadí *po* úspěšném zobrazení Dashboardu.
- **Změna:** V `App.tsx` přidáme `useEffect`, který po dokončení úvodního načtení (`isInitialLoadDone`) spustí dynamické importy na pozadí.

### 3. Fast-Path Update
- **Změna:** V `App.tsx` v bloku `Fast Path` přidáme `const cachedUser = await storageService.getCachedUser()`.

## 📋 Kroky implementace

### Krok 1: Úprava `storageService.ts`
Implementace `getCachedUser` a integrace IndexedDB pro profil.

### Krok 2: Úprava `App.tsx` (User info)
Zahrnutí profilu do okamžitého zobrazení.

### Krok 3: Implementace Prefetching
Přidání logiky pro stahování Deníku a BusinessHubu na pozadí.

---

**Autor plánu:** `project-planner`
**Ověřeno:** `performance-optimizer`, `frontend-specialist`
