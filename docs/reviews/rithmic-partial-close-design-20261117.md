# Rithmic — částečné zavření pozice (návrh, 17. 11. 2026)

Stav: první verze postavená ve službě (op `reduce`), chování Rithmicu se měří na Rithmic Test; UI až po měření a oponentuře.

## Co víme o Rithmicu (změřeno)

- Každý vstup má vlastní serverovou ochranu na své množství (SL + TP svázané burzou).
- Vyplnění jedné nohy zruší její sestru; změna nohy (314) mění jen cenu a vazbu zachová.
- Pozice z přikoupení = 2 ochrany po 1 ks.

## Návrh: zavřít JEDNU ochranu přes její vlastní TP

Částečné zavření = TP jedné ochrany se posune na cenu ZA trhem (prodejní limit pod trhem / nákupní nad trhem,
o `reduceThroughTicks`, výchozí 8 ticků). Burza ho hned vyplní za nejlepší cenu, sesterský SL zruší sama.

- JEDEN zápis (314 na nohu). Žádné rušení noh předem, žádný volný Market.
- Nikdy nevznikne okno bez ochrany ani s ochranou navíc: do vyplnění kryje kus jeho SL, po vyplnění SL zmizí s ním.
- Pozice se nemůže obrátit: noha má množství své ochrany a je to výstupní příkaz téhle ochrany.
- Když se limit nevyplní (trh uteče přes něj během milisekund), zůstane jako TP blíž trhu — pořád svázaný se svým SL.
  Služba to vrátí jako nepotvrzené („výstup je u trhu, nevyplnil se") a nic dalšího nedělá.

### Kdy služba pustí (`reduce { symbol, clientId }`)

1. Pozice má aspoň 2 ks a je CELÁ krytá aspoň dvěma vlastními ochranami ve stavu „chráněno"; služba zná každý
   pracující příkaz kontraktu; žádná samostatná ochrana, žádný čekající vstup.
2. Pozice je usazená (žádné čerstvé vyplnění), neběží ani neskončil nejistě posun noh, služba má čerstvou cenu.
3. Vybere se ochrana s MÉNĚ ochranným SL (dál od trhu); při shodě ta novější. Zbytek pozice tak nese menší riziko.
4. Úspěch = stav ukáže pozici menší o množství ochrany. Bez potvrzení do lhůty → „unknown", nic se neopakuje.

### Co se NEstaví

- Zmenšení jedné ochrany s víc kusy (vstup 2 ks jedním příkazem): změna množství nohy není změřená.
- Částečné zavření pozice se samostatnou ochranou nebo bez ochrany (tam je jen celé zavření).
- Výběr konkrétního kusu uživatelem.

## Pravidla (duchem)

INV-OUTBOX-01/03 (jeden zápis, nejistý se neopakuje), INV-RECON-03 (ochrana se neopravuje obchodem — tady se ochrana
nemění, jen se dřív spustí její vlastní výstup), INV-DEFAULT-02 (bez podmínek odmítnout), INV-UI-01.
Souhlas se skutečným účtem: `reduce` expozici jen snižuje → jde i po vypršení souhlasu.

## Měření na Rithmic Test (před UI)

Pozice 2 ks ze dvou vstupů → `reduce` → ověřit: vyplnění TP za trhem, zrušení sesterského SL burzou, druhá ochrana
beze změny, pořadí zpráv, doba.
