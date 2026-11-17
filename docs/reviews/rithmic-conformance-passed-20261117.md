# Rithmic — conformance splněna (17. 11. 2026)

Mail RAPI týmu z 17. 11. 2026: aplikace byla vidět přihlášená, **conformance je splněna**.

## Co platí

- Název aplikace vždy s předponou: `fikr:AlphaTrade` — pro KAŽDÝ systém Rithmicu (Rithmic 01, Rithmic Paper
  Trading, systémy propek…). Conformance se vede pod adresou filipkrejca1@gmail.com (z jiné adresy Rithmic
  neodpovídá).
- Ke každému systému jsou potřeba vlastní přihlašovací údaje; za přístup aplikací přes R | Protocol API
  mohou být další poplatky.
- Ne každý systém pustí aplikaci koncového uživatele: tam musí aplikaci povolit (white-list) správce toho
  systému — u propky tedy propka.
- Data Nasdaq přes API vyžadují písemné povolení burzy (netýká se CME futures, které obchodujeme).

## Přípojné body R | Protocol (port 443, pro náš klient s předponou `wss://`)

| Místo | Adresa |
|---|---|
| Chicago (jádro) | rprotocol.rithmic.com |
| New York | rprotocol-nyc.rithmic.com |
| Frankfurt | rprotocol-de.rithmic.com |
| Irsko | rprotocol-ie.rithmic.com |
| Colo75 | rprotocol-colo75.rithmic.com |
| Sydney | rprotocol-au.rithmic.com |
| São Paulo | rprotocol-br.rithmic.com |
| Hongkong | rprotocol-hk.rithmic.com |
| Bombaj | rprotocol-in.rithmic.com |
| Soul | rprotocol-kr.rithmic.com |
| Kapské Město | rprotocol-za.rithmic.com |
| Tokio | rprotocol-jp.rithmic.com |
| Singapur | rprotocol-sg.rithmic.com |

Rithmic Test zůstává na `wss://rituz00100.rithmic.com:443`.

## Co to znamená pro nás

- Technická brána je otevřená: s platnými údaji se smíme přihlásit do produkčních systémů.
- Nejbližší brána z ČR je Frankfurt; který bod dává nejnižší latenci k burze (Chicago) versus k nám, je
  potřeba změřit, až budou údaje k systému se živým trhem.
- Místní služba (`scripts/rithmic/devTradeServer.ts`) je dnes natvrdo omezená na „Rithmic Test"
  (`allowedSystems`, kontrola prostředí `demo`). Přechod na jiný systém je vědomý krok přes podmínky
  před ostrým účtem, ne změna jednoho řádku.
- Lucid (hlavní Filipova propka) vlastní API aplikaci odmítl (podpora 17. 11.); technicky jeho Rithmic
  přihlášení třetí platformy pouští (např. XFlow Charts se připojuje údaji propky přes Rithmic).
