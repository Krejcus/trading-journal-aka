# Tradovate copier — controlled conformance runbook

Tento dokument je povinný gate mezi lokálními mock testy a jakýmkoli live
nasazením. OAuth přístup ani přihlášení do Tradovate není souhlas s odesláním
objednávky. Každá fáze se schvaluje samostatně.

## 0. Předpoklady

- Použít pouze Tradovate **demo** prostředí.
- OAuth aplikace musí mít potvrzené scopes pro account/order/position/fill data
  a execution na follower účtech.
- `account/list` musí vrátit leader jako aktivní a všechny followery jako
  aktivní a ne-read-only.
- Před aplikací `20260812050246_copier_runtime_state.sql` udělat a ověřit
  aktuální Supabase backup/export. Migraci aplikovat až po explicitním souhlasu.
- Token nevkládat do zdrojáku, `.env`, localStorage, snapshotu ani logu.
- TradeCopia zůstává zapnutá jako fallback, ale nesmí současně odesílat na stejné
  followery během order-write testu.

## 1. Read-only transport

1. Spustit `startTradovateCopier()` s `environment: 'demo'`.
2. Ověřit WebSocket authorize a právě jeden `user/syncrequest` na lifecycle.
3. Nechat runtime DISARMED. Nevolat `arm()`.
4. Ověřit `account/list`, `position/list`, `order/list`, order graph a contract
   hydration proti skutečným payloadům.
5. Simulovat ztrátu socketu. Musí následovat reconnect, nový sync a stav
   `reconciliationRequired`; ARM se nesmí obnovit sám.

Pass: žádný write endpoint, žádný uniklý token, žádná nekorelovaná entita,
žádný reconnect loop a nulové neošetřené chyby.

## 2. Shadow

1. Provést `reconcile()`.
2. Spustit `arm({ shadowMode: true })`.
3. Přehrát leader submit, partial fill, replace, cancel a reject.
4. Porovnat plánované follower příkazy s referenční kopií, ale nic neodeslat.

Pass: 100 % shoda účtu, symbolu, strany, množství, typu a ceny; nulové
duplicitní klíče; sekvenční gap nebo divergence okamžitě zavře gate.

## 3. Minimální demo write

Vyžaduje nové, výslovné potvrzení uživatele bezprostředně před testem.

1. Všechny účty musí být flat a bez working orders.
2. `reconcile()` musí projít bez divergence.
3. Odeslat jediný minimální demo příkaz na jeden follower.
4. Ověřit HTTP ack, Command, CommandReport, Order, OrderVersion,
   ExecutionReport, Fill a Position.
5. Otestovat modify a cancel pouze na working demo objednávce mimo trh.
6. Po testu DISARM a znovu ověřit flat/no-working-order stav.

Pass: žádná duplicita, žádná osiřelá working order, všechny outbox přechody
durable a auditovatelné, pozice po testu flat.

## 4. Failure matrix

Povinně ověřit v demo nebo řízeným transport fault injection:

- timeout před přijetím a timeout po přijetí;
- pád procesu ve stavu `sending`;
- prázdný current-session lookup (nesmí automaticky retry);
- dva nálezy se stejným tagem (halt + člověk);
- partial fills a duplicitní Fill ID;
- CommandReport reject po HTTP 200;
- disconnect, 15s heartbeat timeout, malformed frame;
- P-ticket, captcha/429 a sync retry s ticketem;
- sequence duplicate/gap/out-of-order;
- missing, inactive a read-only OAuth account;
- position divergence a working order při ARM;
- CAS konflikt dvou runtime procesů.

## 5. Pilot acceptance

TradeCopia se nevypíná, dokud není splněno vše:

- 7 po sobě jdoucích obchodních dní bez divergence pozic;
- 0 duplicitních objednávek;
- 0 nevyřešených outbox položek na konci seance;
- 0 automatických reconciliation/flatten obchodů;
- p95 `totalMs` pod předem schváleným limitem;
- každý disconnect vedl k DISARM + ruční reconciliation;
- každá konfigurace nebo ruční outbox resolution vedla k novému DISARM;
- prop firma písemně dovoluje tento způsob kopírování pro dané účty.

## 6. Rollback

- DISARM všechny runtime instance.
- Zastavit lokálního/VPS agenta.
- V Tradovate ručně ověřit working orders a pozice na všech účtech.
- Nic automaticky nedorovnávat. Rozdíl řešit až po lidské kontrole.
- Uchovat snapshot, audit a metriky; nemažou se kvůli „čistému restartu“.

