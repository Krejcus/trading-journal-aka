# AlphaTrade / AlphaBridge — pokyny pro Claude

1. **Nejdřív si přečti `docs/PROJECT_LOG.md`** — sdílenou paměť všech AI
   asistentů (Claude i Codex/GPT). Po významné práci do něj přidej datovaný
   zápis podle pravidel v jeho hlavičce.
2. Platí stejná pravidla jako v `AGENTS.md` (struktura projektu, ověření
   změn, bezpečnost a produkce, návratový bod) — přečti si ho a řiď se jím.
3. Copier je bezpečnostně kritický kód: DISARMED default, fail-closed,
   žádný blind retry, divergence se nikdy neopravuje obchodem. Detaily
   a zdůvodnění v `docs/PROJECT_LOG.md` a `docs/COPIER_VPS_PLAN.md`.
4. **Změny jádra kopírky** (ARM/DISARM, kill switch, day lock, kontrola pozic /
   reconcile, outbox a zápisy u brokera, relay příkazy, incidenty a `lastError`,
   způsobilost účtů, risk brány, worker lease, durable safety stav):
   - před návrhem si přečti `docs/COPIER_INVARIANTS.md` a výslovně vypiš
     dotčená pravidla `INV-*`;
   - návrh i hotový diff před commitem dej agentovi `copier-design-critic`
     a jeho verdikt uveď v odpovědi; „BLOKUJE“ / „OPRAVIT PŘED COMMITEM“
     se řeší před commitem;
   - zobrazovací změny LIVE (cache, animace, texty) jdou přes pravidla
     INV-UI-*; nic zobrazovacího nesmí autorizovat příkaz.
