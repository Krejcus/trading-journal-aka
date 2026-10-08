# Oponentura: ON si samo kontroluje pozice (f59805da + 57f1df0e)

Agent `copier-design-critic` (podle `docs/COPIER_INVARIANTS.md`), 2026-10-08 · Pro: session „kvalita kopirky“
Verdikt: **OPRAVIT** — testy (`copierArmSelfCheck`, `copierWorkerArmPreparation`, 34/34) jedou
proti mocku controlleru s namockovaným `reconcile()`.

Stav nasazení (zjištěno 8. 10. ~22:15): worker na Macu (`copier-agent.mjs` 22:10) tuto
logiku obsahuje; automatický re-arm je gated `options.autoRearmAfterTransport === true`
(výchozí vypnuto), takže body 1, 2 a 4 se teď neprojeví. **Bod 3 platí naživo.**

## Nálezy
1. **INV-DEFAULT-03 / RECON-02 — auto re-arm smaže incident schovaný za jiným blokerem.**
   Pojistka (agent ~:872, tick ~:1220) čte `armPreparation.manualRecoveryRequired`, což je jen
   `blockedBy === 'incident'` (controller ~:15982); `armPreparationBlocker` (8736–8746) vyhodnotí
   `starting` dřív než `incident`. Scénář: transport disarm → durable commit selže → `failClosed`
   (6953–6959) zapíše ne-transportní incident, procesor `failed` → status `blockedBy:'starting'`,
   `manualRecoveryRequired=false` → pojistka projde → veřejné `reconcile()` (recover,
   `clearLastError`, smaže durable marker 15460–15473) → ARM. Oprava: samostatné pole
   `incidentPending` (`armPreparationIncidentRequiresRecovery || lastError`) nezávislé na pořadí
   blokerů; interní cesta nesmí volat veřejné `reconcile()`.
2. **INV-RECON-02 „Nikdy nevolat veřejné reconcile() z background procesu“.** Auto re-arm
   (zdroj `internal`) ho volá při každém pokusu (až 40×), stačí `state==='needed'` po vypršení
   30s receiptu. Vedlejší efekty: audit jako ruční kontrola, uvolnění account sync pauz,
   ukončení managementOnly, smazání durable markeru. Oprava: interní read-only reconciliation
   bez recovery side-effectů.
3. **INV-DEFAULT-03 (změna politiky, NAŽIVO): ruční ON = potvrzení incidentu, ale bez vazby na
   incident, který člověk viděl.** Scénář: ARM z telefonu čeká v relay (TTL 30 s), mezitím vznikne
   nový incident (např. divergence při resyncu za vypnuté kopírky, ~12196–12201); ARM doběhne,
   kontrola vyjde čistě, incident se smaže a kopírka zapne. Oprava: ARM payload nese
   `acknowledgedIncidentAt/id`; worker maže jen shodný incident s `at ≤ createdAt` příkazu, jinak
   ARM odmítne; audit „ON potvrdil incident X“; UI ukáže důvod incidentu před ON (viz
   `remove-position-check-button-20261008.md`, bod 2). Aktualizovat INV-DEFAULT-03, RECON-01/02.
4. **INV-RECON-01 „reconnect nikdy sám neARMuje“.** V posuzovaných commitech byl auto re-arm
   výchozí ON; HEAD (779bdc0b, 8d6b6f38) ho vypnul a čeká na prázdnou relay frontu — správně,
   ale INV-RECON-01 je třeba výslovně přepsat a `status()` musí čekající re-arm hlásit (jinak
   člověk vidí OFF a kopírka se do 30 min sama zapne). Drobnost: opakuje staré
   `accountEligibilityExclusions` a ignoruje novější zpřísnění.
5. **INV-ARM-01 (nízké, NEOVĚŘENO).** `flatReconciledLeaderEpochIds` obchází bránu nedokončené
   leader epochy (~8533) a plní se i z interních reconciliation (14432–14445); ověřit, že
   znovuotevření epochy id ze sady odstraní.

## Chybějící testy
- incident schovaný za `blockedBy:'starting'`/`'kill-switch'` + auto re-arm;
- interní ARM nesmí volat veřejné `reconcile()` (spy);
- ARM z relay starší než incident nesmí incident smazat;
- `failClosed` během await v kontrole uvnitř ON; brzda během kontroly v interní cestě;
- restart workeru se nesmí sám znovu zapnout;
- integrace se skutečným `bootstrapCopierRuntime` místo mocku.
