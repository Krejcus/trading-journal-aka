# Obchodování z appky — co umí a co chybí (3. 11. 2026)

Stav nasazeného kódu 7ae5c97b (web) / e37d7963 (worker). Sestaveno ze čtyř průzkumů kódu, kontroly
úplnosti a protikontroly každého řádku (6 skeptiků). **Ruční DEMO** = dnešní instalace workeru
(jedna DEMO skupina bez followerů, `--manual-only --scale-in on`). **IBKR** = běžící IB Gateway jako zdroj ceny.

## Co appka umí dnes
- Limit vstup se SL+TP jako nativní OSO u brokera — PC i telefon, i skupina s followery; jen MNQ, jen za ARMED.
- Stop vstup se SL+TP — totéž, navíc jen s IBKR.
- Market se SL+TP — jen ruční DEMO a s IBKR.
- Holý Market z lišty telefonu + „Přidat SL/TP“ — jen telefon, ruční DEMO, IBKR.
- Přikoupení do pozice — Limit/Stop po 1 ks, Market i víc, jedno čekající, SL/TP musí být jako u pozice; jen ruční DEMO.
- PC panel: velikost podle rizika v $, SL/TP v bodech/ticích/$, „Zkontrolovat u workeru“, tažení čar návrhu, pravý klik do grafu. Telefon: „+“ u kříže, position box ⚡.
- Správa: tažení SL/TP (TP jen od trhu), BE přesně na průměr vstupu, × zavřít celou pozici (za ARMED), × zrušit čekající vstup/přikoupení (i za OFF).
- Flatten All (lišta na PC i pod grafem, Dashboard, telefon), Flatten účtu, zavření kopie followera — každý Flatten vypne kopírku.
- Kopírování: on-submit (Market/Limit/Stop/StopLimit, OSO, bracket, částečné výstupy z Tradovate), on-fill jen jako Market bez nohou.
- Správa obchodů zadaných v Tradovate — jen ve skupině s followery a jen OSO/bracket, který kopírka kopíruje.

## Co chybí (★ = největší přínos pro daytradera)

### Typy vstupních příkazů
- ★ Víc TP / rozdělený výstup (TP1 + TP2). Vstup je vždy jedno OSO s jedním SL a jedním TP → změna jádra.
- ★ Trailing stop — typ v systému vůbec není (a zadaný v Tradovate shodí čtení, viz Riziko).
- StopLimit vstup z grafu (broker vrstva ho umí poslat, kopírka ho kopíruje, chybí jen vstup); MIT vůbec.
- Limit/Stop bez SL/TP a vstup jen se SL nebo jen s TP — holý smí být jen Market.
- Víc čekajících vstupů naráz: žebřík, OCO breakout (buy stop nad + sell stop pod), druhé čekající přikoupení.
- Time-in-force (Day/GTC) se neposílá; čekající vstup z flat se sám nezruší na konci okna ani session (to umí jen přikoupení).
- ATM šablony (uložené SL/TP), závorky jako odstup od skutečného fillu. Výchozí je napevno SL 12 b / TP 2R; u Marketu skluz mění R.
- Skutečný bid/ask v panelu a join bid/ask (UI bere poslední cenu, ask = +1 tick; skutečný bid/ask má jen worker).
- Market se SL/TP blíž než 4 b (16 ticků) — těsný scalp stop u Marketu nejde.
- Vstup v posledních 5 minutách obchodního okna, před koncem session (17:00 CT) nebo vypršením ARM.
- Alert / TradingView webhook → příkaz (upozornění jen notifikují).

### Správa pozice
- ★ Částečné zavření (zmenšit o N kontraktů). Jde jen celá pozice → změna jádra.
- ★ Reverse / otočení pozice. Opačný vstup v pozici je blokovaný.
- ★ Automatický BE po X ticcích a auto-trail. SL jde jen ručně.
- ★ Posun čekajícího vstupu tažením, posun jeho SL/TP před fillem, změna qty. Dnes jen zrušit a zadat znovu.
- BE + n ticků, BE s poplatky, SL/TP zadáním čísla; TP blíž k trhu; SL/BE blíž než 8 ticků od trhu.
- Zrušit jen jednu nohu, doplnit jen SL; „Přidat SL/TP“ na PC nebo k pozici z Tradovate.
- × zavřít holý Market bez SL/TP (zbývá Flatten, který vypne kopírku).
- Cancel All (zrušit příkazy, nechat pozici). Tlačítko Cancel na Dashboardu worker neprovede.
- Správa, když je na účtu cizí příkaz, rozjeté nohy nebo částečně vyplněný vstup → jen Flatten (výjimka: pozice z přikoupení v ručním DEMO).
- Posun SL/TP během čekajícího přikoupení (jde jen zavřít nebo přikoupení zrušit).
- Posun SL/TP, BE a × za vypnuté kopírky.
- Posun SL typu StopLimit (např. nastaveného v Tradovate).
- Automatické zavření leadera při denní ztrátě, denní cíl zisku, zavření na konci okna (day lock jen blokuje nové vstupy; zavření umí jen vypršení ARM).
- Telefon: „Zrušit“ čekajícího vstupu v liště = Flatten celé skupiny + vypnutí kopírky; jemně jde jen × na čáře v plném grafu.

### Rozsah (účty, skupiny, symboly)
- ★ Market, holý Market, „Přidat SL/TP“ a přikoupení ve skupinách s followery (prop účty). Fáze 2; Market brzdí, že kopírka nespáruje Market rodiče s nohami.
- ★ Víc než 1 kontrakt v běžné skupině, víc než 5 v ručním DEMO, změna stropu z appky (reinstalace bez volby vrátí 1).
- Skutečné Tradovate LIVE s vlastními penězi (vše běží v prostředí demo; prop účty ano).
- Jiné symboly: NQ graf jen zobrazí, ES/MES vůbec; ruční volba kontraktu v týdnu rollu.
- Vstup na vybraný účet (výběr v panelu je, odeslání ho odmítne), na leadera bez kopie ve skupině s followery, za OFF.
- Market a Stop bez IB Gateway (bez IBKR jen Limit).
- Přikoupení do pozice z Tradovate, holé přikoupení z lišty, Limit/Stop přikoupení > 1 ks, přikoupení s jiným SL/TP.
- Správa obchodů zadaných v Tradovate v ručním DEMO (bez followerů je kopírka nesleduje).
- Víc skupin nebo workerů najednou.

### Kopírování na followery
- On-fill followeři nedostanou SL/TP nohy ani jejich posuny a ruční vstup z grafu zablokují.
- Kopie na jiný symbol (NQ→MNQ), inverzní kopie, pevné qty followera.
- Follower s násobkem < 1 zablokuje celý vstup; strop followera kopii neořízne (follower obchod vynechá).
- Ruční vstup chce flat bez příkazů i u všech followerů.
- Lucid ↔ Tradeify: technicky jde, drží to jen pravidlo do písemného potvrzení Tradeify.
- Samostatná správa followera z grafu (jiný SL nebo × jen u něj).
- Brána proti kopii bez ochrany (příkaz z Tradovate bez SL/TP odejde i followerům bez SL/TP).
- Za ARMED jdou pravidla followerů jen zpřísnit (uvolnění až další session).

### Ovládání (PC vs. telefon)
- ★ Klávesové zkratky (Buy/Sell, Flatten, BE, Cancel) — žádné nejsou.
- DOM / price ladder, Time & Sales, hloubka trhu.
- Telefon: riziko v $, jednotky SL/TP, „Zkontrolovat“, táhnutelné čáry návrhu (list bere jen kontrakty a ceny).
- Telefon: ovládací čáry ve dvou oknech grafu a při přehrávání (jen v jednom plném grafu).
- PC: holý Market, šipky živých fillů, předvolby qty (má jen telefon).
- Všechny pracující příkazy jako čáry; rozjeté SL/TP nohy graf nenakreslí vůbec.
- Akce z push notifikace / Live Activity (Flatten, BE, zrušit).
- Zvuk/hlas při fillu přímo v appce (jen push se systémovým zvukem), paper trading na živých datech.

## Riziko nalezené cestou
Trailing stop, MIT nebo jiný nepodporovaný typ zadaný v Tradovate na **kterémkoli účtu stejného přihlášení**:
worker ho neumí složit (`supportedOrderType` v `services/tradovateBroker.ts` vyhodí výjimku pro všechny příkazy
bez filtru účtu), synchronizace streamu spadne a po reconnectu znovu, dokud příkaz v seznamu je. Kopírka je
fail-closed (nic neodešle), ale přestane vidět účty. Z kódu, bez testu a bez ověření u brokera. Oprava = změna
jádra (nepodporovaný typ = cizí příkaz, který zablokuje vstup na tom účtu, ale nespadne stream) → INV-* + critic.

## Poznámky
- Market, Stop a „Přidat SL/TP“ potřebují IB Gateway; utažení SL a BE jde i s cenou z P&L brokera.
- Pro prop účty je potřeba reinstalovat worker jako běžnou skupinu — tam jde jen Limit/Stop po 1 ks se SL+TP a správa čarami.
- Nové typy (trailing, víc TP, částečné zavření) chtějí nejdřív záznam u Tradovate na DEMO, pak změnu jádra kopírky.
- Flatten (všechny varianty) vypne kopírku a zneplatní kontrolu pozic; × u pozice v grafu kopírku nevypne.
