# Plán optimalizace rychlosti: AlphaTrade Mentor v1.5 [SPEED-BOOST]

## 🎯 Cíl
Snížit čas do prvního interaktivního zobrazení (LCP) z **8-9s** na **< 2s**.

## 🏗️ Strategie

### 1. Rozbití monolitu (Code-Splitting)
Aplikace se nyní stahuje jako jeden velký 1.8MB soubor. Rozdělíme ho tak, aby se při startu stáhlo pouze nezbytné minimum pro Dashboard.

| Komponenta | Přístup | Ukládání kódu |
| :--- | :--- | :--- |
| **Dashboard** | Statický import | Okamžitě |
| **DailyJournal** | `React.lazy` | Při kliknutí / Na pozadí |
| **Settings** | `React.lazy` | Při kliknutí / Na pozadí |
| **BusinessHub** | `React.lazy` | Při kliknutí / Na pozadí |
| **NetworkHub** | `React.lazy` | Při kliknutí / Na pozadí |
| **ManualTradeForm** | `React.lazy` | Při otevření |

### 2. Akcelerace datového toku (Fast-Path First)
Upravíme inicializační sekvenci v `App.tsx`:
- **Paralelizace:** Spustíme `supabase.auth.getSession()` a `storageService.getTradesCheckCacheFirst()` ve stejnou chvíli (pomocí `Promise.all`).
- **Okamžitý render:** Jakmile máme data z cache, okamžitě nastavíme `setLoading(false)`. Nečekáme na úspěšnou synchronizaci se serverem. Serverová data se "dotáhnou" později.

### 3. Vizuální kontinuita (UX)
- Zavedení `Suspense` loaderu, který plynule přepne mezi načítáním komponenty a jejím zobrazením.

## 📋 Kroky implementace

### Krok 1: Příprava Lazy Loading
Úprava importů v `App.tsx` na dynamické importy.

### Krok 2: Úprava Inicializace
Refaktor `useEffect` pro načítání dat tak, aby upřednostňoval cache a nesekvenoval čekání.

### Krok 3: Ověření
- Build aplikace.
- Kontrola velikosti hlavního balíčku (target: < 600KB).
- Manuální test "pocitové" rychlosti.

---

**Autor plánu:** `project-planner`
**Ověřeno:** `performance-optimizer`, `frontend-specialist`
