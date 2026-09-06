# Zadání pro Codex: auto-otevření popoveru AlphaTrade Status při změně stavu

Datum: 2026-09-03 · Spec: `docs/MENUBAR_COMPANION_SPEC_20260831.md` §11 (v1.4)

## Co postavit

1. `CompanionTransitionDetector` (Domain): čistá funkce nad dvěma
   prezentacemi z freshness reduceru, vrací `Transition { category:
   worsening | improvement | mode, sectionId, rowId?, reason }` nebo nil.
   Přesná matice spouštěčů a „nikdy" případů je v §11.1.
2. Anti-flap 3 s + rate limit 30 s + ochrana proti nižší `revision` v
   `CompanionStore` (nový stav se „usadí", teprve pak se detektor volá).
3. `AppDelegate.presentTransition(_:)`: `popover.show` bez `NSApp.activate`,
   `.transient`, auto-close timer (60 s / 8 s) pozastavený při hoveru,
   rozbalení jen cílové sekce, highlight řádku 1,2 s, pulz pillu 3×,
   Reduce Motion bez pohybu. Otevřený popover se jen aktualizuje.
4. `UNUserNotificationCenter`: souhlas při prvním zhoršení, text = hlavní
   stav + jedna věta důvodu, bez účtů a P&L; klik otevře popover.
5. Nastavení v hlavičce popoveru (ozubené kolo): 4 přepínače z §11.4,
   `UserDefaults`.

## Bezpečnostní hranice (beze změny)

Žádné ovládání copieru, žádné brokerové volání, žádný nový endpoint.
Přechody vycházejí výhradně z existujícího reduceru — zlepšení se nikdy
nehlásí ze stale dat, STAV NEZNÁMÝ do 90 s nikdy nespouští.

## Testy (povinné)

Matice přechodů §11.1 včetně negativních případů, anti-flap, rate limit,
rollback revize, start/wake bez auto-otevření, nastavení vypnuto ⇒ nic.
XCTest runner na tomto Macu selhává „hung before establishing connection";
pokud se nerozběhne, testy detektoru pusť alespoň přes `swift test`/CLI a
uveď to v logu.

## Doručení

Feature větev nad `origin/main`, build 6 (`CURRENT_PROJECT_VERSION = 6`),
Release build + instalace do `~/Applications` se zálohou buildu 5, zápis do
`docs/PROJECT_LOG.md`. Merge do `main` = produkce (docs/app only; PWA se
nemění).
