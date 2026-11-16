# Rithmic — výsledky důkazu proveditelnosti (16. 11. 2026)

Krok 1 plánu `rithmic-work-plan-20261116.md`. Skript
`scripts/rithmic/feasibility.ts` (TypeScript klient `services/rithmic/`),
systém **Rithmic Test**, účet 1875, kontrakt ESZ6, Mac v ČR. Surová data:
`scripts/rithmic/results/feasibility-2026-11-16T14-36-35-668Z.json`
(složka není v gitu). Všechny scénáře A–G doběhly; úklid: žádný pracující
příkaz, pozice 0.

**Co to nedokazuje:** testovací prostředí není živý trh ani ostré servery;
vyplnění jsou simulovaná; neměřil se telefon ani cesta klik → čára v grafu;
částečná plnění a závod zrušení × vyplnění nešlo vyvolat.

## Verdikt: jít dál

Nic z toho, co mohlo plán zabít, se nepotvrdilo. Bracket drží server,
ztracený příkaz jde dohledat, stav po obnovení spojení sedí. Jedno zjištění
mění návrh Flattenu (bod 3) a jedno potvrzuje obavu z review (bod 6).

## Naměřeno

### 1. Rychlost (TypeScript klient, 20 kol)

| Krok (do potvrzení burzy) | medián | max |
|---|---|---|
| Vložení Limitu | 147 ms | 154 ms |
| Posun ceny | 147 ms | 153 ms |
| Zrušení | 145 ms | 154 ms |
| Market do vyplnění | 145 ms | — (1 pokus) |
| Market: SL i TP aktivní | 183 ms od odeslání | — (1 pokus) |

Pozice v PnL plantu se změnila 1 ms po vyplnění. Přihlášení tří plantů ~2 s.

### 2. Vstup se SL/TP (bracket)

- SL/TP se zadávají v tickách od ceny vyplnění; nohy **vzniknou až po
  vyplnění** jako samostatné příkazy (vyplnění 7587,25 → TP 7607,25 = +80
  ticků, SL 7577,25 = −40 ticků). Ochrana byla aktivní 38 ms po vyplnění
  a **drží ji server**, ne náš proces.
- Rodič nese `bracket_type` už v první notifikaci. Nohy nesou
  `original_basket_id` = rodič a `linked_basket_ids` = obě nohy, ale až od
  druhé notifikace (první `ORDER_RCVD_FROM_CLNT` je nemá).
- Stop noha skončí ve stavu `trigger pending` — je potvrzená burzou
  (přišlo burzovní `STATUS` se spouštěcí cenou), tedy pracující ochrana.
- Před vyplněním jde vzdálenost SL změnit (334); po vyplnění se noha mění
  jako běžný příkaz (314) a burza potvrdí `MODIFY`.
- `ResponseBracketOrder` / `ResponseNewOrder`: `basket_id` je v datovém řádku
  odpovědi, konečná odpověď ho nést nemusí.

### 3. Zavření pozice NERUŠÍ nohy ⚠

`RequestExitPosition` pošle tržní příkaz a pozici zavře, ale **SL a TP
zůstaly pracovat** (ve snímku po zavření: TP `open`, SL `modified, trigger
pending`). Na flat účtu by zásah kterékoli z nich otevřel novou pozici.
→ Flatten u Rithmicu musí být: zrušit nohy → ověřit → zavřít → ověřit stavem.
`RequestCancelAllOrders` nohy zrušil.

### 4. Ztráta spojení po odeslání příkazu

Spojení shozeno 0 / 20 / 60 / 100 ms po odeslání: klient vždy vrátil
`unknown` (nikdy „neodesláno") a **příkaz na serveru ve všech čtyřech
případech vznikl** — i při shození hned po `send()`. Po novém přihlášení ho
snímek příkazů našel podle `user_tag` (obnova + dohledání ~1,3–1,6 s).
Potvrzuje pravidlo: výjimka ze `send()` ani pád spojení nejsou důkaz, že
příkaz neodešel.

### 5. Snímek příkazů (320) a historie (324)

- 320 vrací **pracující i dnešní dokončené** příkazy (42 řádků na konci běhu).
- Dokončené mají `status: complete` a typ posledního hlášení
  (`FILL` / `CANCEL` / `REJECT`); `report_type` u zrušeného je `cancel`.
- Pracující: `open`, `modified`, `trigger pending`, `modified, trigger pending`.
- Příkaz, který nedošel na burzu (odmítnutí RMS), je ve snímku **jen jako 351**
  (`COMPLETE`, důvod `FA`), ne jako 352 — klient teď sbírá oba.
- 324 pro dnešní datum vrátilo 0 řádků (formát data nebo jen minulé dny —
  nezjištěno). Dohledání proto stojí na 320.
- Řádky snímku dorazily před ukončením požadavku (kromě 351, viz výše).
- `basket_id` je číselné a rostoucí; při změně příkazu se nemění.

### 6. Odmítnutí

- **RMS (500 kontraktů, limit účtu 40):** odpověď na příkaz je **přijato**
  s `basket_id`; pak jen 351 `ORDER_RCVD_FROM_CLNT` → `COMPLETE` s důvodem
  `FA` a textem „Rejected at RMS …". Žádná burzovní notifikace. Přesně to,
  co review čekala: kdo by čekal na burzovní `REJECT`, držel by fantomový
  příkaz.
- **Burza (cena mimo tick):** přijato → burzovní `REJECT` s textem →
  351 `COMPLETE` důvod `R`.
- Důvody dokončení: `F` vyplněno, `C` zrušeno, `R` odmítla burza, `FA`
  odmítl Rithmic.
- **Zrušení neexistujícího příkazu vrátilo „ok"** — odpověď na zrušení není
  důkaz ničeho; existuje notifikace `CANCELLATION_FAILED`.

### 7. Obnova a souběh

- Shození všech tří spojení a nové přihlášení včetně snímků: 2,6 s; seznam
  příkazů před a po je shodný; snímek P&L dorazil (řádky před ukončením, 117 ms).
- **Druhé přihlášení stejným účtem prošlo a první zůstalo připojené.**
  Limit účtu: 5 souběžných přihlášení k příkazům, 1 k datům. Rithmic nás
  tedy před dvěma instancemi nechrání — jedinou instanci musíme vynutit sami.
- RMS účtu: stav `active`, nejvyšší příkaz 40, limit nákupu/prodeje 20,
  ztrátový limit; dotaz 304 funguje.
- Server posílá šablonu 358, kterou definice neznají (klient ji přeskakuje).
- Dotaz na hledání symbolů (109) jednou do 10 s neodpověděl; front month
  test nevrací. Kontrakt se zadává přímo.

## Dopad na návrh adaptéru

| Otázka z review | Odpověď měření |
|---|---|
| Vzniknou nohy až po vyplnění? | Ano → stav „ochrana přijata, nohy nevznikly" je nutný |
| Nese první notifikace `bracket_type`? | U rodiče ano; u noh vazby až od druhé |
| Odmítnutí RMS bez burzovní notifikace? | Ano → 351 `COMPLETE` + důvod `FA` je konečný stav |
| Je `definitive` odmítnutí poznat z odpovědi? | Ne — odpověď je „přijato" i u odmítnutého → rozhodují notifikace |
| Pokrývá snímek dokončené příkazy? | Ano (dnešní); 324 pro dnešek prázdné |
| Pořadí řádků snímku × ukončení | Řádky dřív (352, 450, 451) |
| Zpoždění pozic za vyplněním | ~1 ms |
| `basket_id` číselné, stabilní | Ano |
| Zavření pozice ruší nohy? | **Ne** |
| Druhé přihlášení shodí první? | **Ne** |

Zůstává nezměřeno: částečné plnění, závod zrušení × vyplnění, pořadí času
351 × 352 pod zátěží, chování na ostrých serverech, poplatky v P&L.

## Conformance

Rithmic (RAPI tým, 16. 11.): osobní conformance do týdne. Vydají předponu
názvu aplikace; aplikace se s ní připojí k příkazům i datům v Rithmic Test
a zůstane běžet, dokud to neověří; pak pošlou adresy ostatních systémů.
Ozvat se máme, až dotestujeme. Připraveno: `scripts/rithmic/conformance.ts`
(jen přihlášení order + ticker a odběr cen, žádné příkazy).
