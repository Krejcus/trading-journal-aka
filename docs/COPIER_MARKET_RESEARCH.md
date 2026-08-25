# Jak to řeší komerční kopírky (TradersConnect, TradeSyncer, Replikanto)

Research: Codex (gpt-5.6-sol ultra, web search), 2026-08-25. Zdroje ověřené webem;
závěry „dopad pro AlphaTrade“ navazují na incident 24. 8.

Níže jsou jen TradeSyncer a Replikanto. Bez reverzního inženýrství; veřejně nepopsané interní mechanismy označuji jako neznámé.

Hodnocení zdrojů:

- **A — primární:** oficiální dokumentace/changelog výrobce nebo Tradovate.
- **B — marketing:** tvrzení výrobce bez metodiky měření.
- **C — komunitní:** jednotlivá zkušenost; užitečná jako varování, ne jako důkaz mechanismu.
- U TradeSynceru uvádějí články jen relativní datum „updated over 2/3 weeks ago“; při rešerši 25. 8. 2026 nebylo přesné datum vidět.

## 1. Venue-side změna množství OCO/ochranné nohy

### TradeSyncer

- **A:** Cloud copier sleduje události leadera `working`, `fills`, `cancels`, `modify` a kopíruje je followerům. Dokumentace také říká, že změny TP/SL leadera se promítnou followerům a OCO protinoha se po fillu zruší. [Copy trading essentials](https://help.tradesyncer.com/en/articles/13905214-copy-trading-essentials), [ATM, bracket and OCO orders](https://help.tradesyncer.com/en/articles/16102779-atm-bracket-and-oco-orders)
- **Co chybí:** není veřejně popsáno, zda rozlišují uživatelský modify od množství změněného brokerovým OSO/OCO enginem, zda po každé změně znovu načtou venue-side stav, ani jak řeší závod „broker právě snížil qty, copier současně posílá starý modify“.
- **A:** Jejich preferovaný únik z celé třídy problémů je `Market Execution Only`: follower nemá resting TP/SL, každý leader fill vyvolá market order stejného směru a velikosti. [Market Execution Only](https://help.tradesyncer.com/en/articles/12994159-how-to-use-market-execution-only-mode)
- **C:** Uživatel na Redditu popsal případ 20 micros, kdy po SL leadera followery zavřely jen 3 a zůstalo 17 kontraktů s aktivním 17-contract SL. Je to neověřený jednotlivý incident. [Reddit, 5.–6. 11. 2025](https://www.reddit.com/r/Tradovate/comments/1ope4qv)

### Replikanto

- **A, velmi přímé:** changelog 1.6.0.0 z **22. 11. 2024** uvádí opravu kopírování změny follower exit orderu, když byla velikost leader exit orderu snížena protější OCO nohou po partial fillu. To dokládá, že viděnou změnu broker/NT order eventu propagují; veřejně ale nepopisují interní detekční algoritmus. [Replikanto release notes](https://download.flowbots.ninja/replikanto/index.html)
- Tentýž changelog obsahuje další relevantní opravy:

  - **21. 5. 2024, 1.5.4.9:** oprava změny qty exit orderu po partial fillu entry.
  - **26. 6. 2024, 1.5.5.0:** Tradovate `Order Change` se volá jen ve stavu `Working`, aby se zabránilo freeze.
  - **1. 8. 2023, 1.4.7.9:** u ATM Copy se cancel/qty změny exitů kopírují jen pro Exact Quantity nebo ratio 1; jinak se zachová qty odvozená z reálné follower pozice.

- **A:** Alternativa `ATM Copy` nechá výstupní příkazy spravovat samostatnou NinjaTrader ATM strategií followera; výrobce tvrdí, že součet exit qty odpovídá otevřené pozici. [ATM Copy](https://flowbots.ninja/blog/atm-copy/)

**Důsledek pro self-hosted Tradovate copier:** order/position event z venue musí být autoritativní; před modify je nutné znovu ověřit aktuální `orderQty`, `cumQty`, stav a follower pozici a nikdy nepřepsat novější brokerovou změnu starým lokálním záměrem.

## 2. Ochrana proti otočení followera

### TradeSyncer

- **A:** `Follower Protection` se aktivuje, když leader dosáhne qty 0. Zkontroluje follower pozice a market orderem zavře jejich přesný zbytek; delay lze nastavit **1,5–3 s**. Také flattenuje leadera a jeho open orders pro daný symbol. [Follower Protection](https://help.tradesyncer.com/en/articles/10410714-how-to-use-follower-protection)
- Pozor na doloženou mezeru: open follower orders, které už na leaderu neexistují, tato funkce **preventivně neruší**. Pokud se později fillnou při flat leaderu, až následně vzniklou follower pozici zavře.
- `Market Execution Only` omezuje riziko ghost entry/exitů tím, že na followerech vůbec nedrží pending příkazy. [Dokumentace](https://help.tradesyncer.com/en/articles/12994159-how-to-use-market-execution-only-mode)
- **Nenalezeno:** explicitní `reduce-only`, pre-submit clamp exit qty na aktuální follower pozici, průběžný position-limit guard nebo dokumentovaný periodický reconciliation interval.
- Jejich dokumentace naopak říká, že Max Open Qty/Positions vynucuje broker a TradeSyncer rejection „cannot prevent“. [Why orders fail](https://help.tradesyncer.com/en/articles/16102746-why-orders-fail-and-how-to-prevent-it)

### Replikanto

- **A:** `Follower Guard` umí po nastaveném zpoždění:

  - zrušit entry, která se nefillnula po fillu leadera;
  - flattenovat followera při qty/side desynchronizaci;
  - od verze **1.5.3+** flattenovat followera, který se otevřel na opačnou stranu;
  - při reject/change/cancel erroru flattenovat a volitelně followera disarmovat;
  - poslat e-mail.  
    [Follower Guard overview](https://support.flowbots.ninja/hc/en-us/articles/27075144231316-Follower-Guard-Overview)

- Kontrola synchronizace je podle výrobce navázaná na změnu pozice, nikoli na doložený periodický polling. Yellow stav standardně pouze varuje a follower dál kopíruje; teprve nakonfigurovaný Guard může flattenovat/disarmovat. [Follower Guard](https://flowbots.ninja/blog/follower-guard/)
- Výrobce sám Guard popisuje jako **reaktivní, ne preventivní**; krátký časovač může během přechodného stale stavu dokonce vyvolat předčasný close/reversal. Doporučuje `Market Only`, `ATM Copy` a před vstupem ověřit, že jsou účty flat. [Counter-position guidance](https://support.flowbots.ninja/hc/en-us/articles/43809665778580-What-is-counter-position-trading-and-how-to-avoid-it)
- Remote nodes mají zásadní omezení: leader nevidí jejich pozice/orders a některé Guard kontroly tam nefungují.
- **Nenalezeno:** skutečný broker-side `reduce-only` ani atomický pre-submit clamp proti otočení.

**Důsledek:** každý exit nejprve omezit na skutečnou venue-side pozici followera; neznámý/stale stav musí znamenat blokaci a DISARM, nikoli pokus o „close“, doplněný event-driven i periodickým reconciliation.

## 3. Latence, paralelismus a transport

### TradeSyncer

- **B:** výrobce inzeruje „typickou latenci pod 100 ms“ a kopírování napříč připojenými účty. Neuvádí metodiku, p50/p95/p99, začátek/konec měření ani nezávislý benchmark. [Tradovate Trade Copier](https://tradesyncer.com/tradovate-trade-copier)
- **A/B:** jde o cloud a přímé broker API; dokumentace ale neříká, zda Tradovate order entry posílají RESTem, WebSocketem, nebo kombinací, ani zda mají paralelní per-account workers, bounded concurrency či sériovou frontu na order.
- Komunitní příspěvky hlásí občasný lag/slippage, ale bez spolehlivého timestampového měření; nelze je použít jako číselný benchmark.

### Replikanto

- **A:** pro kopírování mezi stroji uvádí odhad:

  - local network: **50–500 ms**;
  - internet remote: **100–1000 ms**.  
    Jde o výrobní odhad bez metodiky, nikoli měření stejného stroje. [Using Replikanto as a signal provider](https://support.flowbots.ninja/hc/en-us/articles/37057889510676-Using-Replikanto-as-a-trade-signal-provider)

- **A:** výrobce tvrdí, že příkazy followerům odesílá „simultaneously“. [Execution delay](https://support.flowbots.ninja/hc/en-us/articles/36525974266644-Why-is-there-a-delay-in-my-executions)
- Changelog dokládá technické kroky, ale ne per-account SLA:

  - **24. 6. 2022:** copy speed zlepšena multithreadingem;
  - **22. 9. 2021:** asynchronous local-network node communication;
  - **10. 12. 2021:** remote komunikace přešla z HTTP na rychlejší WS;
  - **23. 11. 2021:** automatický reconnect WS.  
    [Release notes](https://download.flowbots.ninja/replikanto/index.html)

- WS se týká komunikace Replikanto–Replikanto, ne doloženě broker order entry.
- **A:** Replikanto se k Tradovate nepřipojuje přímo; orders pro follower účty odevzdává přes NinjaTrader connection. Přesný downstream transport NT→Tradovate veřejně nepopsalo. [Tradovate connection](https://support.flowbots.ninja/hc/en-us/articles/25644694433172-How-can-I-connect-Tradovate-accounts-to-the-Replikanto)

**Důsledek:** přijímat stav přes WebSocket, fan-out dělat paralelně, ale s omezením podle credential/rate budgetu a serializací na konkrétní order; vlastní p50/p95/p99 měřit od leader venue eventu po follower broker ACK/fill, ne věřit marketingovému „ms“.

## 4. Výpadek/restart a otevřené povinnosti

### TradeSyncer

- **A:** cloud znamená, že uživatelův desktop nemusí běžet. Broker session ale může vypadnout kvůli maintenance, auth nebo limitům a kopírování je přerušeno, dokud se spojení neobnoví. Některé reconnecty jsou automatické, jiné vyžadují ruční zásah. [Essentials](https://help.tradesyncer.com/en/articles/13905214-copy-trading-essentials), [Connection troubleshooting](https://help.tradesyncer.com/en/articles/13906150-troubleshooting-connections)
- Po přerušení doporučují manuální `Flatten All/Group`, který ruší working orders a zavírá pozice. [Best practices](https://help.tradesyncer.com/en/articles/13905195-best-practices-for-copy-trading)
- **Nenalezeno:** chování při restartu jejich vlastní služby, replay nehotových cancel/modify povinností, idempotentní recovery, startup reconciliation nebo durable execution outbox/journal. Jejich uživatelský trading journal není důkaz durable žurnálu exekučních povinností.
- Také veřejně negarantují, co se stane s již working ochrannými nohami během jejich nebo brokerového outage.

### Replikanto

- **A:** NinjaTrader i Replikanto musí běžet. Při offline/sleep stavu nelze odeslat kopie a Follower Guard nemůže chránit účet. Doporučením je stále zapnutý stroj/VPS. [Out of sync](https://support.flowbots.ninja/hc/en-us/articles/36171589005460-Out-of-sync-between-leader-and-followers)
- Tentýž článek výslovně upozorňuje:

  - pending copy inicializovaná těsně před disconnectem se může po reconnectu ještě odeslat, přestože leader mezitím trade ukončil;
  - ATM musí být online při fillu entry, jinak nemusí vůbec vytvořit SL/TP;
  - lokálně simulované OCO potřebuje běžící NT, aby po fillu jedné nohy zrušilo druhou.

- Working broker-side orders mohou být při rate-limit/network problému „frozen“; recovery je reconnect, DB repair nebo přímé zrušení na webu Tradovate. [Frozen orders](https://support.flowbots.ninja/hc/en-us/articles/36160776166548-Frozen-orders)
- **Nenalezeno:** durable outbox/povinnostní journal nebo garantovaný replay po crashi. Persistuje se konfigurace workspace, ne doložená exekuční intent historie.

**Důsledek:** povinnosti place/modify/cancel musí být v durable outboxu; po každém startu načíst venue orders/positions, zablokovat nové kopie a nejdřív deterministicky reconciliovat nehotové povinnosti.

## 5. Divergence follower vs. leader

### TradeSyncer

- **A:** Když leader přejde na flat, Follower Protection **obchodem dorovná na nulu** přes market close přesného follower zbytku. To není jen alarm. [Follower Protection](https://help.tradesyncer.com/en/articles/10410714-how-to-use-follower-protection)
- Není doloženo automatické delta-dorovnání, když jsou leader i follower stále otevření, ale mají jinou qty/side.
- Standardní recovery je Orders History → ruční kontrola → `Flatten All` → ověřit flat → malý test trade. [Troubleshooting](https://help.tradesyncer.com/en/articles/13905201-troubleshooting-trade-copying)
- Není veřejně popsán automatický halt/disarm na každou divergenci ani reconciliation cadence.

### Replikanto

- **A:** Yellow stav je primárně alarm a účet obvykle dál kopíruje. Uživatel má porovnat pozice a ručně vstoupit, upravit qty nebo flattenovat. [Out-of-sync indicator](https://support.flowbots.ninja/hc/en-us/articles/25648608527508-Why-is-my-follower-yellow-instead-of-green-circle-Out-of-sync)
- Volitelný Follower Guard po delay followera **flattenuje a disarmuje**; nedorovnává ho automatickým delta-tradem na aktuální non-flat leader pozici. [Follower Guard overview](https://support.flowbots.ninja/hc/en-us/articles/27075144231316-Follower-Guard-Overview)
- Remote leader vůbec nevidí follower positions/orders; výrobce výslovně říká, že synchronizaci negarantuje a vyžaduje ruční monitoring/komunikaci. [Remote signal provider](https://support.flowbots.ninja/hc/en-us/articles/37057889510676-Using-Replikanto-as-a-trade-signal-provider)
- **C:** Reddit obsahuje opakované popisy missed exits a následných reverse/hidden positions; odpovědi doporučují Follower Guard. Jde o incidentní svědectví, ne kontrolovaný test. [Reddit, 25. 10. 2023 a další komentáře](https://www.reddit.com/r/Daytrading/comments/17g8rll)

**Důsledek:** bezpečný default je alarm + DISARM + případně flatten, ne slepý corrective trade; automatické delta-dorovnání má být zvláštní explicitní politika pouze při čerstvém, úplném a jednoznačném venue snapshotu.

## 6. Tradovate rate limits, cancel/modify a penalty box

### TradeSyncer

- **A, ale vendorová interpretace:** uvádí **5 000 requests/hod.**; place/modify/cancel a údajně i price updates spotřebovávají limit. U 20 followerů je jeden stop modify 20 callů. Doporučuje:

  - `Market Execution Only`;
  - minimum modifikací a žádné rychlé cancel/replace bursty;
  - omezit trailing stops;
  - stabilní session, ne opakované reconnecty/usersync;
  - při throttlingu pause/resume nebo nové připojení.  
    [Tradovate API limits](https://help.tradesyncer.com/en/articles/16102785-tradovate-api-limits)

- P-ticket popisují zjednodušeně jako čekací stav s omezeným/blokovaným API.
- **Nenalezeno:** interní token bucket, coalescing stop změn, per-order serialization, prioritní rezerva pro emergency cancel/flatten, reakce na `p-time`, nebo retry/backoff algoritmus.

### Replikanto

- **A, vendorová interpretace:** uvádí **5 000/h**, v textu také „80/min“. Doporučuje:

  - nepoužívat trailing stops;
  - nedělat více rychlých price changes;
  - `Market Only`;
  - při UI freeze kliknout Flatten jen jednou, ne opakovaně;
  - při zablokovaných orders použít Tradovate web;
  - případně požádat Tradovate o vyšší limit.  
    [Rate Limit Exceeded](https://support.flowbots.ninja/hc/en-us/articles/36161235334676-Rate-Limit-Exceeded), [P-Ticket](https://support.flowbots.ninja/hc/en-us/articles/44404103624212-Penalty-P-Ticket-Error), [Frozen orders](https://support.flowbots.ninja/hc/en-us/articles/36160776166548-Frozen-orders)

- **Nenalezeno:** vlastní adaptivní throttling, modify coalescing nebo formální emergency-call budget.

### Důležitá korekce z primárního Tradovate zdroje

Vendor help články směšují dva mechanismy. Aktuální oficiální dokumentace Tradovate je rozlišuje:

- user-level limit vede na `429`;
- endpoint limit může vrátit v těle `200 OK` pole `p-ticket`, `p-time`, případně `p-captcha`;
- retry se smí provést až po `p-time` a s přiloženým ticketem;
- předčasné opakování přidává backoff a může skončit `429`;
- při `429` se má zastavit veškeré volání na hodinu; každý předčasný pokus hodinový interval znovu spustí.  
  [Tradovate Rate Limits](https://partner.tradovate.com/overview/core-concepts/rate-limits), [Penalty Tickets](https://partner.tradovate.com/overview/core-concepts/penalty-tickets), [obecná API dokumentace](https://api.tradovate.com/)

**Důsledek:** self-hosted copier potřebuje sdílený rate limiter přes všechny followery/endpointy, no-op suppression, debounce/coalescing modify, per-order serializaci a přesné zpracování `p-ticket`/`p-time`; při `429` fail-closed zastavit celý credential bez „testovacích“ retry.

## Co se nepodařilo věrohodně doložit

- Žádný nezávislý reprodukovatelný latency benchmark TradeSynceru nebo Replikanta.
- Žádná veřejná implementace skutečného `reduce-only`.
- Žádná doložená durable obligation/outbox architektura ani jednoho produktu.
- Žádný přesný popis Tradovate REST-vs-WebSocket order-entry cesty TradeSynceru; u Replikanta je doložen jen NinjaTrader intermediary a WS mezi remote Replikanto instancemi.
- Žádná užitečná konkrétní diskuse o těchto interních mechanismech na futures.io se přes webový index nenašla.
