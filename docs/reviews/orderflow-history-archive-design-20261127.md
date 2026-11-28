# Order flow v minulosti — archiv a doplnění z Rithmicu (návrh, 27. 11. 2026, verze 2 po oponentuře)

Stav: **fáze 0–1 hotové 28. 11.** (syrová data NQZ6 od září na disku, viz PROJECT_LOG 28. 11.); zbytek návrh.
**Rozhodnutí 28. 11.:** zdroj = Rithmic (Databento MBO 171 USD zamítnuto); bubliny přesné ze služby, jinde přibližné
(`bubbles: "approx"`, slučování 10 µs + průjezd 100 µs). Strana: `bid_volume` = kupující.

Původně: Navazuje na `orderflow-profile-bubbles-design-20261127.md` (fáze 1–4 nasazené)
a na sondu `scripts/rithmic/measureTickHistory.ts` (výsledky v PROJECT_LOG 27. 11.). Verze 2 zapracovává
oponenturu (Claude subagent, 27. 11.) — co se změnilo, je na konci.

## Cíl

Bubliny a Volume profil (den, seance, natažený) i pro dny, kdy služba neběžela nebo už je mimo jejích 7 dní:
v LIVE grafu po odrolování, v grafu obchodu v deníku a v backtestu — na PC i v telefonu, i když Mac neběží.

## Co víme (měřeno / ověřeno v kódu)

| Fakt | Zdroj |
|---|---|
| Historie obchodů z Rithmicu má u každého obchodu stranu agresora (bid xor ask) a čas na µs | sonda: 150 000 obchodů, 0 nejasných |
| Jen pro běžící kontrakt: NQZ6 2–60 dní zpět ano, prošlé U6/M6/Z5 prázdné (i svíčky) | sonda |
| 10 000 obchodů na žádost; `resume_bars` vrátil celé 2h okno (352 794 obchodů za 8,6 s) | sonda |
| Číslo agresivního příkazu v historii NENÍ → bubliny jen přibližně | protokol 207 |
| `request()` drží všechny řádky odpovědi v paměti až do konce | `rithmicClient.ts` / `rithmicPlant.ts` |
| Služba sama drží spojení k historii; **po vynuceném odhlášení se už nepřipojí** (ceny stojí do restartu) | `devTradeServer.ts:626` |
| Agregátor seskupuje bubliny jen podle čísla příkazu, drží 7 dní podle hodin, strop 30 000 obchodů | `orderFlowAggregator.ts:162, 205, 88` |
| Klientský `OrderFlowStore` čte jen zprávy `of-snapshot` (jeden symbol, snímek ho vymaže) | `lib/orderFlowStore.ts:109–216` |
| Soubory služby: `results/orderflow-<systém>-<kontrakt>-<UTC den>.jsonl` v checkoutu, odkud služba běží (dnes `alphatrade-worktrees/rithmic`), NQ i MNQ; restart uprostřed minuty ji zapíše znovu | `orderFlowFeed.ts:149, 184`, `orderFlowAggregator.ts:322` |
| Obchodní den v appce = `tradingDayKey` (hranice 18:00 New York) | `services/liquidityLevels.ts:114` |
| Velikost: 154 minut NQ (27. 11.) = 231 kB, gzip 60 kB → souhrn celého dne řádově 0,3–0,8 MB gzip | soubor služby |

**Termín:** dny od zářijového přechodu na NQZ6 jdou stáhnout jen do expirace NQZ6 (**pátek 18. 12. 2026**).
Na to ale stačí **stáhnout syrová data na disk Macu** — úložiště, klíč ani appka kvůli termínu spěchat nemusí.

## Návrh

### A. Syrová data na disk (jediná věc s termínem)

Skript `scripts/rithmic/orderFlowBackfill.ts --raw`:
- **Jen při vypnuté službě a pod jejím zámkem.** Vezme si stejný zámek jako služba
  (`service-<instance>.lock`, `flag: 'wx'`), takže služba se uprostřed stahování nespustí a stahování se
  nespustí vedle služby. Žádná automatika v noci — druhé přihlášení by službu nechalo bez cen
  (`devTradeServer.ts:626`), a to i s otevřenou pozicí přes noc. Druhé přihlášení vedle služby se nikdy
  nezkouší na LucidTrading; když vůbec, tak jen na Rithmic Test.
- **Okna po 1 h** (paměť: celá seance RTH může mít přes milion řádků). Řádově 23 žádostí na den, ~55 dní
  ≈ 1 300 žádostí → rozložit do víkendů 28.–29. 11., 5.–6. 12., 12.–13. 12. (předem ověřit, že historie
  o víkendu odpovídá). Rozpočet žádostí na běh a konec při jakékoli zmínce o limitu/oprávnění, jako sonda.
  Stažené hodiny se zapisují průběžně, přerušený běh pokračuje tam, kde skončil.
- **Ukládá syrové obchody** (sec, µs, seq, cena v ticích, velikost, strana) jako gzip po obchodních dnech
  a kontraktech do `~/Library/Application Support/AlphaTrade/rithmic/orderflow-raw/NQZ6/<den>.bin.gz`.
  Ze syrových dat jde seskupení bublin kdykoli přepočítat (až se změří jeho přesnost).
  Duplicity na hranách oken se odstraní podle (sec, µs, seq).
- Kontrola úplnosti hned při stahování: objem po minutách proti minutovým svíčkám Rithmicu téhož okna
  (jedna žádost na celý den — týden minutových svíček přijde za 0,5 s). Den, kde to nesedí, se označí
  a stáhne znovu.
- Disk: odhad jednotky MB na den gzip → stovky MB celkem; skript odmítne běžet pod 10 GB volna
  (stejně jako noční záloha).

### B. Formát dne (souhrn pro zobrazení)

Soubor na **obchodní den podle `tradingDayKey`** a **konkrétní kontrakt**: `<user_id>/NQ/<kontrakt>/<den>.json.gz`.

```
{ "v": 1, "contract": "NQZ6", "tradeDate": "2026-11-25", "tickSize": 0.25,
  "source": "live" | "backfill" | "merged", "tradeFloor": 5, "bubbles": "exact" | "approx",
  "minutes": [[čas minuty, [cena v ticích, nákup, prodej, bez strany, …]], …],
  "coverage": [[od, do], …],                  // úseky, kde data tekla (jako live pokrytí)
  "trades": [[id, začátek ms, KONEC ms, strana, velikost, dílčích, lo, hi, průměr], …],
  "check": { "candleVolume": …, "flowVolume": …, "minutesShort": [ … ] } }
```

- **Konec obchodu (`endMs`) hned ve v1** — bez něj by backtest ukázal velikost bubliny dřív, než se celá
  zobchodovala.
- Bubliny od 5 NQ (stejný práh, jaký dnes ukládá služba; 15 je jen výchozí práh zobrazení).
- **Převod:** syrová data → stejný agregátor v **historickém režimu** (vlastní hodiny místo `Date.now`,
  bez sedmidenního úklidu, vyšší strop obchodů, číslo příkazu = `"<sec>.<µs>:<strana>"`). Soubory služby →
  převodník (jen NQ, u minuty poslední záznam, přeskládání UTC dnů na obchodní dny, den uzavřený 10 min
  po konci obchodního dne).

### C. Úložiště a nahrávání (až po A, bez spěchu)

- **Supabase Storage**, soukromý bucket `orderflow-archive`, gzip, strop 3 MB na soubor; tabulka
  `orderflow_archive_days` (user_id, contract, trade_date, source, bubbles, complete, bytes, sha256,
  uploaded_at). Klienti jen čtou svou složku a své řádky (RLS), nikdo z klientů nezapisuje ani nemaže.
- **Účelový klíč pro Mac** podle vzoru `priceAlertWatchKey.ts`, ale přísnější:
  - podpis váže `čas · akce · cesta · sha256 · bajty` (ne jen slovo „trigger“);
  - server hlídá datum v povoleném rozsahu, kvóty (počet a bajty za den), `backfill` nepřepíše `live`,
    nahrání bez přepisu (`upsert: false`, sha v cestě);
  - **klíč se do Macu dostane skriptem** (`orderFlowArchive.ts --set-key` ze schránky po zkopírování
    v nastavení appky) a uloží se do Application Support — obchodní služba se kvůli tomu nemění ani
    nerestartuje;
  - odvolání = nový štítek klíče (všem najednou), proto kvóty a zákaz přepisu.
- Nahrávání: `prepare` (podepsaná adresa přímo do Storage) → nahrání → `commit` (server soubor ověří
  podle sha a zapíše řádek). Data tak jdou přes Vercel jednou při ověření, 2 volání na den. Ověřit tarif
  Vercelu (počet funkcí v `api/`); případně jedna funkce s akcí.
- Archivář (launchd jednou za hodinu) nahrává uzavřené dny ze souborů služby a souhrny ze syrových dat.
  Soubory služby hledá podle cesty z nastavení (dnes `alphatrade-worktrees/rithmic`); lepší je, aby je
  služba při příštím restartu ukládala do Application Support jako `price-alerts.json`.
- Licence dat: archiv jen pro vlastníka, nikdy do sdílení dne.

### D. Zobrazení v appce

- **Samostatný store archivu** vedle živého (`OrderFlowStore` je jeden symbol a snímek ho maže) a společné
  rozhraní pro čtení, které primitivum spojí z obou; `useOrderFlowLayer` dostane zdroj dat místo pevného
  `orderFlowLink.store`. Deník a backtest se ke službě nikdy nepřipojují.
- **Kontrakt podle svíček grafu** (deník bere `.v.0` nebo kontrakt dohledaný podle ceny), ne pravidlem
  „8 dní před expirací“ — jinak by profil v týdnu přechodu seděl o rozdíl kontraktů vedle. Slučovat jen
  stejný kontrakt.
- **Backtest bez pohledu dopředu:** minuta až při `minuta + 60 ≤ kurzor`, bublina až při `endMs ≤ kurzor`,
  profily jen z odkrytých minut.
- Načítání po dnech ve viditelném rozsahu, telefon jen viditelný den; gzip přes `DecompressionStream`
  s náhradou (fflate) pro starší iOS; mezipaměť v IndexedDB.
- Den bez dat: v legendě „OF: bez dat pro tento den“; dny `approx`: „bubliny přibližné“.
- JEN ZOBRAZENÍ (INV-UI-01/04): archiv nečte nic z příkazů a příkazy nečtou archiv; test na importy jako
  u živého store.

## Pořadí stavby

| Fáze | Obsah | Hotovo, když |
|---|---|---|
| 0 | **Sonda 2** (jen čtení, Filip při vypnuté službě): celý den po minutách proti svíčkám, čas a paměť hodinového okna, odkdy má NQZ6 data, stažení 27. 11. pro porovnání s živým souborem, odpovídá historie o víkendu? | objem po minutách sedí **≥ 99,5 %**, jinak se nepokračuje; známe přesnost přibližných bublin |
| 1 | Stahování syrových dat (A) a jeho běhy o víkendech | **všechny obchodní dny NQZ6 od přechodu na disku před 18. 12.** |
| 2 | Formát dne, historický režim agregátoru, převodníky (B) — čistá logika + testy | převod 27. 11. dá stejný profil jako živý graf |
| 3 | Úložiště, klíč, archivář (C) — **migrace jen po výslovném ano** | v tabulce jsou dny od září |
| 4 | Appka (D): LIVE starší dny, deník, backtest s kurzorem, telefon | profil a bubliny na obchodu z října v deníku na PC i iPhonu |
| 5 | Po každém přechodu kontraktu stáhnout zbytek dnů starého kontraktu (ručně, při vypnuté službě) | — |

Fáze 0–2 nic nenasazují ani nemění obchodní službu.

## Co se změnilo po oponentuře (27. 11.)

- Termín 18. 12. se týká jen stažení na disk, ne úložiště a appky (dřív byly fáze 2–3 „nutné do 18. 12.“).
- Žádné automatické stahování vedle služby; zámek služby místo `pgrep`; druhé přihlášení jen na Rithmic Test.
- „Žádný nový parser“ neplatil — samostatný store archivu, převodníky, historický režim agregátoru.
- Kontrakt v cestě a podle svíček grafu; den podle `tradingDayKey` (18:00 NY), ne 17:00 CT.
- `endMs` u bublin kvůli backtestu; práh pokračování ≥ 99,5 % objemu.
- Klíč přísnější (podpis celé operace, kvóty, bez přepisu) a do Macu přes skript, ne přes obchodní službu.
- Okna po 1 h kvůli paměti a rozložení do víkendů.

## Co potřebuju rozhodnout

1. Stáhnout **všechny** obchodní dny od přechodu na NQZ6 (~55 dní, 3 víkendy), nebo jen dny s tvými obchody?
2. Souhlasíš, že stahování poběží **jen o víkendu a při vypnuté službě** (pouštíš ho ty jedním příkazem)?
3. Sondu 2 napsat hned, ať ji pustíš už tenhle víkend (28.–29. 11.)?
