# AlphaTrade / AlphaBridge — pokyny pro Claude

1. **Nejdřív si přečti `docs/PROJECT_LOG.md`** — sdílenou paměť všech AI
   asistentů (Claude i Codex/GPT). Po významné práci do něj přidej datovaný
   zápis podle pravidel v jeho hlavičce.
2. Platí stejná pravidla jako v `AGENTS.md` (struktura projektu, ověření
   změn, bezpečnost a produkce, návratový bod) — přečti si ho a řiď se jím.
3. Copier je bezpečnostně kritický kód: DISARMED default, fail-closed,
   žádný blind retry, divergence se nikdy neopravuje obchodem. Detaily
   a zdůvodnění v `docs/PROJECT_LOG.md` a `docs/COPIER_VPS_PLAN.md`.
