# Předání pro Codex — session Claude 17.–18. 9. 2026

Všechno je na `origin/main` (poslední commit 5211015). Časy UTC. Worker na
Macu běží z commitu 0df6c6b (bundle d393c9a2…), start 19:42:14Z, manifest jen
Tradeify 53157614 + Lucid 754e4b5b; commit 5211015 (počítání syncrequest) do
workeru ještě nasazený není.

## 1. Incidenty a co je prokázané

| Čas | Co se stalo | Stav poznání |
|---|---|---|
| 17. 9. 15:41–19:30 | Tradovate pomalý/nedostupný, retry bouře importu journalu (40001), REST bez deadline, Flatten 5/12, crash loop workeru při startu | opraveno (viz 2), příčina na straně Tradovate potvrzena jen pro večer 19:30Z (504 z Vercelu) |
| 17. 9. 16:11 | leader 25 MNQ, 4 Lucid followeři odmítnuti prop limitem, skupina fail-closed bez auto-close, 7 kopií bez správy | opraveno: odmítnutý follower se izoluje, skupina zůstává ARMED |
| 18. 9. 12:23 | banner „Data deníku čekají na obnovení“ | opraveno: RPC 12,7 MB/7,8 s → 5,1 MB/1,7 s |
| 18. 9. 14:14–14:17 | fail-closed `modify-unconfirmed-filled`; follower 65839434 (FundedNext) podle workeru **-25 MNQ při flat leaderu**; FundedNext účty „liquidation only“ (breach) | **NEOVĚŘENO** — pozici 65839434 ověřit v historii FundedNext/Tradovate |
| 18. 9. 15:33 | odebrání FundedNext účtů ze skupiny selhávalo | opraveno (chyba UI), odebrání prošlo |
| 18. 9. 15:41–16:42 | Tradovate zavřel 3 sockety v jedné minutě; Tradeify+FundedNext hodinu mrtvé (authorize OK, sync bez odpovědi, REST 45 s timeout, Vercel 408), Lucid OK | **příčina neprokázaná** |
| 18. 9. 18:08 | Lucid socket zavřen (kód 1005, clean), 2× sync timeout → vynucená obnova tokenu → funguje | mechanismus nejasný |
| 18. 9. 18:50–19:25 | Tradeify socket 1006, 2× sync timeout, obnova tokenu, pak **p-ticket na syncrequest** (broker čekal potichu ~32 min) | endpointový limit na IP prokázaný |

Oficiální limity (partner.tradovate.com/overview/core-concepts/rate-limits,
/penalty-tickets): uživatel 5 000/h přes všechny endpointy (429; dnes ani
jednou), endpointové limity na IP /24: `syncrequest` 300/h, `accesstokenrequest`
5/h (p-ticket/p-time, předčasné opakování sčítá). Žádný limit 80/min.
Do IP budgetu workeru se počítá i platforma Tradovate a iPhone na téže síti.
Nový token nevytváří nový limitový prostor.

## 2. Změny v kódu (commit → co)

### Copier / worker (bezpečnostně kritické)
- 9e3d09c, 7ffaaf2: lease renewal 120 s + in-process retry (10 min), startovní čtení účtů s retry, WS sync 5 s → 20 s (později 45 s).
- 6a5379a, 3ecebdc: `read_journal_input_snapshot` indexované stránkování; `journal-input-changed` errcode 40001 → 55000 (konec retry bouře). Migrace 20260917153000, 20260917154500.
- 2db341c: REST v brokeru s deadline (`restRequestTimeoutMs`, 45 s) včetně čtení těla; Flatten: retry čtení v 60 s budgetu, deadline 180 s, jeden resend nativní likvidace jen se stavovým důkazem; relay Flatten attach na běžící Flatten (groupId+accountId); journal import lease (migrace 20260917190000); evidence renewal gaps ≤ 60 s.
- 1e4f808, 6a456d7, 40737f8: broker-rejected entry followera → `sidelineRejectedFollower` (intentionalEntrySuppression allowedNet 0), async i sync cesta; `BrokerOrderAck.policy`, `OutboxEntry.rejectedBy`; vázáno na `leaderExposureEpoch`; policy bloky zůstávají fail-closed.
- 2461613, acd6741: `controller.exposure` (positions, followers ok/detail, orders z cache stream eventů) → Mac companion DTO a LIVE overlay (`lib/tradovateWorkerExposureOverlay.ts`).
- 3480a71: `createBrokerRouter` — agregát `connected` počítá jen spojení nesoucí účet skupiny; spojení bez účtů nepropouští chyby; `replaceRoutes` přepočítá. Pilot: spojení s nečitelným adresářem účtů po 10 min retry startuje bez účtů (žádný crash loop).
- d8a930d: `onSessionSuspect` v brokeru (sync timeouty v řadě), `services/copierSessionRenewalPolicy.ts` (práh 2, cooldown 5 min), pilot `sessionSuspectHandler` → `provider.refresh({ forceRenewal: true })` → `api/tradovate/oauth/pilot-lease` `forceRenewal` (jen device auth, token < 3 min se neobnovuje).
- 3408088: diagnostika `WS CLOSE code/reason/clean/socketAgeS`, `WS AUTHORIZED afterMs`, `WS SYNC TIMEOUT phase=`.
- b93a7c2: `WS PENALTY request p-time p-captcha p-message` + chybová událost „sync penalized (p-time X s)“ do lastError.
- e3281ab, 5211015: broker `usage()` (REST/WS/syncrequest za min/h, phase, streamConnected, lastClose, penaltyUntil, consecutiveSyncTimeouts) → pilot `connectionUsage[]` ve statusu (`lib/localCopierAgentProtocol.ts`).
- Nasazení workera: 17. 9. 21:0x (aa0c83f), 18. 9. 06:0x (40737f8), 07:5x (2461613), 10:55 (acd6741), 17:50 (3408088, FundedNext odebráno z manifestu, záloha `connections.json.bak-20260918T175002Z`), 19:42 (0df6c6b). Vždy `scripts/copier/mac-reinstall-safe.sh` + read-only reconcile.

### Web / server
- cbbdc17: `get_dashboard_data_light_v1` + `get_trade_analytics_v1` (migrace 20260918120000, nasazena `db query -f` + repair); Lab/AI dotahují analytiku zvlášť (`lib/tradeAnalyticsMerge.ts`); fallback 500 řádků; timeouty 45/90 s; avatar > 256 kB odložen, upload zmenšen na 256 px (`lib/avatarImage.ts`).
- 9c9d3aa: profilový modal čeká na zápis a hlásí chybu (dřív falešné „uloženo“).
- 69827d3: odebrání nedostupného followera z řádku odebere všechny nedostupné (jinak validace `follower-unavailable` shodila uložení).
- 2eaaa9c: LIVE drží poslední známé pozice, štítek stáří po 120 s, 429 → 5 min/p-time.
- b93a7c2: live-pnl intervaly 1/2/5 s → 3/6/15 s; server sdílí ticky 2,5 s / cash 5 s na (uživatel, připojení).
- e3281ab, 5211015: live-pnl vrací `brokerCalls`; klientská telemetrie po připojení; panel „Diagnostika dat a API“: na login web + worker vs 5 000/h (tempo 83/min orientačně), syncrequest workeru vs 300/h na IP, věta o session (penalizace s odpočtem, poslední close kód a kdo zavřel).
- Testy: 3 765/3 765 (vitest), tsc, eslint, build OK po každém commitu.

## 3. Co jsem vyvodil špatně (opraveno v deníku 22:15)
- „Limit 80/min“ (z Tradesyncer) — neexistuje.
- p-ticket přisouzen tokenu a zátěži z webu — je na IP, Vercel s ním nesouvisí.
- „Nový token = nová session = oprava“ — shoda okolností, ne mechanismus.
- Close kódy 1005/1006 jako důkaz zavření Tradovate — nejsou.

## 4. Otevřené body
1. **Účet 65839434**: ověřit -25 MNQ ze 14:16Z v historii FundedNext/Tradovate.
2. Tiché stally sync/REST (15:41, 18:08, 18:50): příčina neznámá; nová diagnostika + panel mají zítra ukázat čerpání a close kódy. Test: dopoledne LIVE otevřené, kopírka DISARMED, sledovat panel.
3. Support: Tradovate Partner Support s UTC časy, endpointem, close kódy a poli tiketu; Tradeify jen kvůli omezením loginu.
4. Izolace mrtvého follower spojení podle fáze obchodu (flat → mimo nové vstupy; v obchodu zdravým dál exity/SL/TP, odpojené UNKNOWN/DEGRADED) — nerealizováno, čeká na rozhodnutí.
5. FundedNext: spojení zachovat, pozastavit živé brokerové čtení (web ho stále polluje bez účtů).
6. Jeden řízený datový tok na login s rozpočtem požadavků; vlastní token workeru jen pro oddělení execution session.
7. Reinstall workera z 5211015 (syncrequest počítadlo) — až z DISARMED/reconciled stavu.
8. Plist `--followers` nese stále 11 účtů (jen fallback, durable skupina má 6).
