# 🏥 Trade Replay Resurrection Guide

Tento dokument slouží k dokonalé obnově systému **Trade Replay** a **Candle Sync**, pokud se v budoucnu rozhodneš jej vrátit.

## 📦 1. Nutné knihovny (Dependencies)
Pro zprovoznění bude nutné nainstalovat tyto balíčky:
```bash
npm install lightweight-charts dukascopy-node idb-keyval
```

## 🏗️ 2. Soubory a jejich umístění
Soubory v tomto archivu patří na následující místa:

| Zdroj v archivu | Cílové umístění v projektu | Účel |
| :--- | :--- | :--- |
| `components/TradeReplay.tsx` | `components/TradeReplay.tsx` | Hlavní chart engine a logika |
| `components/InteractiveOverlay.tsx` | `components/InteractiveOverlay.tsx` | Kreslení na grafy |
| `components/PlaybackWidget.tsx` | `components/PlaybackWidget.tsx` | Ovládací panel přehrávání |
| `components/ChartToolbar.tsx` | `components/ChartToolbar.tsx` | Nástroje pro kreslení |
| `services/candleCache.ts` | `services/candleCache.ts` | IndexedDB úložiště svíček |
| `services/prefetchService.ts` | `services/prefetchService.ts` | Načítání dat na pozadí |
| `api/candles.ts` | `api/candles.ts` | Vercel Serverless Function (Dukascopy API) |
| `utils/candleUtils.ts` | `utils/candleUtils.ts` | Agregace svíček (m1 -> m5, h1 atd.) |

## 🔌 3. Integrace (App.tsx)
V `App.tsx` je nutné:
1. Importovat `TradeReplay` (přes `React.lazy` pro výkon).
2. Přidat `DataService.syncIncremental` do `useEffect` při startu pro synchronizaci instrumentů.
3. Vložit `TradeReplay` komponentu do modulu detailu obchodu.

## 🗄️ 4. Databáze (Supabase)
Systém využívá tabulku `candle_cache`. Pokud by byla smazána, SQL skript pro její obnovu se nachází v hlavním kořenu jako `MASTER_CANDLE_SETUP.sql`.

---
**Status Archivace:** 23. 1. 2026 - Systém plně funkční, odstraněn z důvodu optimalizace výkonu.
