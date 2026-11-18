# Rithmic z iPhonu — návrh a stav (18. 11. 2026)

Navazuje na debatu s GPT 6.2 Astra (`rithmic-phone-codex-20261118.md`, zadání od Clauda, odpověď Codexu doslova).
Větev `claude/rithmic-night-20261117`. Nic z toho není nasazené ani ověřené na iPhonu.

## Jak to funguje

```
iPhone (appka)  ──wss──▶  Tailscale Serve na Macu  ──▶  127.0.0.1:3313 (port pro zařízení)  ──▶  služba  ──▶  Rithmic
PC (prohlížeč)  ──ws───▶  127.0.0.1:3311 (jako dosud, klíč ze souboru)                       ──▶  táž služba
```

- Služba běží dál jen na Macu a poslouchá jen na `127.0.0.1`. Do sítě ji pouští Tailscale Serve — šifrovaně a jen
  zařízením ve Filipově síti Tailscale. Žádný náš server mezi tím není.
- Telefon má **vlastní klíč**, který vznikne při párování. Starý sdílený klíč z PC na portu pro zařízení neplatí.
- Druhý displej nestojí u Rithmicu nic: telefon se připojuje k už běžící službě (žádné další přihlášení ani dotaz).

## Přihlášení v appce = spárování telefonu s Macem

1. Na Macu: `npx tsx scripts/rithmic/pairDevice.ts` → osmimístný kód (platí 5 minut, jedno použití, po pěti
   špatných pokusech propadá). Volba `--scope close|read` omezí, co telefon smí.
2. V telefonu: LIVE → Graf → „Spárovat s Macem": adresa Macu v síti Tailscale + kód + název zařízení.
3. Služba vydá telefonu klíč; uloží si jen jeho otisk. Telefon klíč uloží do iOS Klíčenky (vázaný na zařízení).
4. Při každém připojení pošle telefon klíč první zprávou (ne v adrese). Dokud ho služba neověří, neodejde nic
   o účtu ani ceně.
5. Odvolání: `pairDevice.ts --list` / `--revoke <id>` — otevřené spojení odvolaného zařízení končí hned.

Přihlášení do appky (Supabase) zůstává, jak je; ke spárování se zatím neváže (viz „Odloženo").

## Co telefon smí

| Rozsah zařízení | Smí |
|---|---|
| `full` | vše, co dovolí režim služby (na skutečném účtu jen s místně vydaným souhlasem) |
| `close` | zavřít pozici, zrušit příkaz, spravovat SL/TP |
| `read` | jen číst |

- **Potvrzení incidentu jde jen na Macu**, z telefonu nikdy (uvolňuje blokaci, rezervace i nejistotu najednou).
  Zavřít pozici z telefonu jde vždy.
- **Obchodování na skutečném účtu z telefonu nejde zapnout.** `--live-trading` / `--close-only` spouští jen Filip
  v terminálu na Macu opsáním věty; telefon pak smí jen to, co služba právě dovoluje.
- Správu zařízení (kód, seznam, odvolání) služba přijímá jen z Macu.

## Co je postavené

| Část | Soubor | Ověřeno |
|---|---|---|
| Párování, klíče, rozsah (čistá logika) | `services/rithmic/devicePairing.ts` | testy |
| Brána pro zařízení (WebSocket) | `services/rithmic/deviceGateway.ts` | testy proti skutečnému WebSocketu |
| Port pro zařízení ve službě (`--mobile`), zámek jediné instance, trvalé hodinové okno přihlášení | `scripts/rithmic/devTradeServer.ts` | jen typy; proti Rithmicu ne |
| Nástroj na Macu | `scripts/rithmic/pairDevice.ts` | ne |
| Strana telefonu: adresa, párování, Klíčenka | `lib/rithmicDeviceLink.ts`, `lib/rithmicLocalLink.ts` | testy (Klíčenka nahrazena) |
| Přihlášení klíčem v prvním rámci | `lib/rithmicLocalConnection.ts`, `hooks/useRithmicLocalTrading.ts` | testy |
| Panel „Spárovat s Macem" | `components/RithmicPairingPanel.tsx` | ne (vzhled neviděn) |
| Telefonní graf napojený na Rithmic | `components/RithmicPhoneChart.tsx` a spol. | viz PROJECT_LOG |

## Kde jsem se s Codexem neshodl nebo jeho návrh odložil

- **Klíč v Secure Enclave s podpisem výzvy** (Codex) × **náhodný klíč v Klíčence** (postaveno). Podpis je silnější
  (klíč nikdy neopustí čip a nejde přehrát), ale chce nový Swift kód. Klíč v Klíčence jde přes TLS uvnitř
  WireGuardu a jde odvolat; beru to jako první verzi, Secure Enclave jako další krok.
- **Holý Market jedním klepnutím** — Codex je proti. Filip tuhle lištu 1. 11. výslovně schválil (jako TradingView).
  Na skutečném účtu to stejně rozhoduje souhlas vydaný na Macu (`requireStop`): vyžaduje-li SL, služba holý vstup
  odmítne. Nechávám, jak Filip schválil; rozhodnutí je jeho.
- **Společná kniha operací pro PC a telefon** (Codex) — NEPOSTAVENO. Dnes: příkaz, na který se ztratí odpověď, zná
  jen zařízení, které ho poslalo; služba ale sama nepustí druhý vstup, dokud je první na cestě, a nic se neopakuje.
  Než budou PC a telefon obchodovat souběžně na skutečném účtu, je to potřeba dořešit.
- **Vazba na Supabase uživatele, QR kód, launchd** — odloženo (viz níže).

## Odloženo / otevřené

1. **Lucid a vlastní aplikace.** Podle záznamu ze 17. 11. podpora Lucidu vlastní API aplikaci odmítla, i když
   přihlášení technicky funguje. Než se cokoli pustí na skutečný účet, potřebuje to Filip mít od Lucidu písemně.
2. **Když Mac spadne nebo usne, z telefonu nejde nic — ani zavřít.** Ochrana (SL/TP) leží u burzy a platí dál;
   náhradní cesta pro zavření je platforma propky. Nezávislá vzdálená brzda (starší návrh) postavená není.
3. **Ověření na skutečném iPhonu:** jestli WebView pustí `wss://…ts.net`, jaký posílá Origin, chování na mobilních
   datech a po zamčení telefonu. Dokud to neproběhne, je to „postaveno", ne „funguje".
4. **Stav účtu v penězích** (zůstatek, denní P&L) služba telefonu zatím neposílá — je vidět účet, režim, pozice,
   příkazy a otevřený výsledek.
5. **launchd** (automatický start služby): jen pro režim čtení; obchodní režimy chtějí člověka u terminálu.
   Zatím se služba pouští ručně.
6. **Deník z Rithmicu:** služba obchody ukazuje, ale neukládá; poplatky a víc účtů neřeší.

## Co je potřeba od Filipa

- Tailscale zapnutý na Macu i v iPhonu pod stejným účtem; v síti Tailscale povolené HTTPS (certifikáty).
- Na Macu jednou: `tailscale serve --bg --https=443 http://127.0.0.1:3313` (vystaví port pro zařízení jen do
  soukromé sítě) a zjistit jméno Macu (`tailscale status`, tvar `macbook-air.tailXXXX.ts.net`).
- Službu pouštět s `--mobile`.
- iPhone připojený k Macu a odemčený na instalaci appky.
- Rozhodnutí: rozsah telefonu (`full` × `close`), holý Market na skutečném účtu ano/ne, a vyjádření Lucidu.
