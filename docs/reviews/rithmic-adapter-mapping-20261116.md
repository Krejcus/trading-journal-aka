# Rithmic adaptér — předběžné mapování na `BrokerPort` (16. 11. 2026)

Pracovní podklad pro krok 2. **Není to návrh ke schválení** — ten vznikne až
z výsledků `scripts/rithmic/feasibility.ts` a půjde přes `copier-design-critic`
a Codex. Otazníky níže jsou přesně to, co skript měří.

## Co je hotové (větev `claude/rithmic-20261116`)

- `services/rithmic/rithmicCodec.ts` — rámce a protobuf (definice z knihovny
  async_rithmic 1.6.6; ověřeno proti skutečné bráně dotazem na systémy).
- `services/rithmic/rithmicPlant.ts` — jedno spojení: přihlášení, heartbeat,
  párování odpovědí. Žádné opakování; výsledek `rejected` / `unknown` / `not-sent`.
- `services/rithmic/rithmicClient.ts` — příkazy, brackety, snímky, ceny, P&L.
- `tests/rithmicClient.test.ts` — 17 testů proti napodobenému serveru.
- `scripts/rithmic/feasibility.ts` — scénáře A–F proti `Rithmic Test`.

Do workeru nic z toho zapojené není.

## Mapování

| `BrokerPort` | Rithmic | Stav |
|---|---|---|
| `placeOrder` | 312 RequestNewOrder, `user_tag` = tag | přímé; `unknown` → `definitive: false` |
| `placeOso` (vstup + SL/TP, absolutní ceny, 3 ID) | 330 RequestBracketOrder (ticky od ceny vyplnění, nohy až po fillu) | **nesedí** — viz níže |
| `placeOco` | není přímý ekvivalent pro existující pozici | odložit (mimo první verzi) |
| `modifyOrder` | 314 (celý nový stav); nohy bracketu před fillem 332/334 | potvrzení = 352 `MODIFY`; ověřit u nohou |
| `cancelOrder` | 316; potvrzení = 352 `CANCEL` | přímé |
| `liquidatePosition` | 3504 RequestExitPosition | ověřit, zda ruší i nohy |
| `listOrders` | 320 RequestShowOrders (snímky 352) | ověřit rozsah (jen pracující?) |
| `findOrdersByTag` | 320 + 324 historie dne + filtr `user_tag` | **klíčové** — scénář D |
| `findOrderById` / `findOrderStatusById` | stejné zdroje, filtr `basket_id` | dtto |
| `listPositions` | PnL plant 402 snímek + 450 | ověřit úplnost a „flat" |
| `listAccountCapabilities` | 302 účty, 304 RMS info, trade routes | účet bez trade route = nelze obchodovat |
| `listAccountRiskSnapshots` | 451 (balance, P&L), 304 (loss limit, min balance) | prop trailing drawdown Rithmic neposílá → `null`, nikdy 0 |
| `subscribe` | 351/352/353/450 → `BrokerEvent` | fill = 352 `FILL` (dílčí množství) |
| `connection` + `resync` | nové spojení + 320 + 402 | mezera snapshot × stream — scénář E |
| `accountId: number` | Rithmic má text (`fcm`, `ib`, `account`) | trvalá tabulka identit, žádné `parseInt` |
| `environment` | `Rithmic Test` / `Rithmic Paper Trading` = demo, ostatní live | podle názvu systému, výchozí live |

## Hlavní otevřená věc: vstup se SL/TP

Tradovate `placeOso` posílá tři příkazy naráz s absolutními cenami a vrací tři
ID; jádro (`copierRuntimeController`, korelátory, `copierOsoOutbox`) s nimi
počítá. Rithmic bracket:

- SL/TP se zadávají jako **vzdálenost v tickách od ceny vyplnění**, ne jako cena;
- nohy podle všeho vznikají až po vyplnění vstupu, takže při odeslání **nemají ID**;
- před fillem se vzdálenost mění zvláštní zprávou (332/334), po fillu jsou nohy
  běžné příkazy.

Varianty pro krok 2 (rozhodne se podle měření):

1. **Nativní bracket + nový stav „ochrana přijata, nohy nevznikly"** v portu
   (doporučení Codexe). Bezpečné při výpadku klienta — drží to server.
   Cena SL/TP se odvodí ze skutečného fillu, ne z ceny v lístku.
2. Vstup a po fillu OCO z klienta — **zamítám**: mezi fillem a ochranou je okno
   bez SL závislé na našem procesu (proti INV-OUTBOX-03).

## Invarianty, které adaptér nesmí porušit

INV-OUTBOX-01/02/03 (zápis před odesláním, žádný blind retry, atomický bracket),
INV-TRAD-03 (dohledání podle značky), INV-RECON-01/03 a INV-FRESH-01 (reconnect =
nová autoritativní kontrola, snapshot bez mezery), INV-WORKER-01/02/03 (jediný
zapisovatel), INV-DEFAULT-01 (start vždy vypnutý), INV-RISK-01 (neznámá risk
hodnota je `null`).
