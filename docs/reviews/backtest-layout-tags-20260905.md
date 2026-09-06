# Backtest: layouty, šablony, poznámky a tagy — 5. 9. 2026

Lokální audit a opravy navazující na kompletní backtest review. Testování používá izolovaný localhost, syntetické obchody a mocky externích služeb. Žádný deploy, broker příkaz, skutečný AI požadavek ani zápis do vzdálené databáze nebyl proveden.

## Závěr a používání

- Vlastní tagy se přidávají přímo v review obchodu pod **Vlastní tagy**. Uložené názvy se nabízejí u dalších obchodů aktuálního uživatele. Tag existuje jako součást uloženého obchodu, nikoli jako oddělený neomezeně trvalý katalog: pokud ho odstraníš ze všech obchodů, zmizí i z nabídky.
- HTF/Entry konfluence nabízí položky z Nastavení → Strategie a ruční konfluence uložených obchodů. Původ nových automatických konfluencí je uložený v `autoConfluence`; v review je značí **Auto**. Přepočet přepisuje jen prokazatelně automatické tagy. Starší neoznačené tagy zůstávají zachované.
- Poznámku je nutné uložit. Coach uvnitř aplikace ji může analyzovat spolu s tagy a obchodem; opravené retrieval nástroje čtou aktuální načtený záznam. Editace poznámky sama neznamená nové AI vyhodnocení ani aktualizaci předchozí konverzace. Sémantické pořadí výsledků může stále vycházet ze staršího embeddingu, aktuální obsah nalezeného obchodu se ale dohledává z deníku. Nad prvních 500 backtest obchodů prompt přiznává vynechaný počet a odkazuje na dohledání.

## Nalezené a opravené vady

1. Zavření workspace zachytilo stav před posledním checkpointem grafu. Flush nyní nejprve synchronně přečte panely, kresby a vzhled. `pagehide` vyvolá poslední lokální uložení; násilné ukončení procesu před dokončením IndexedDB nelze garantovat.
2. React StrictMode nebo nové načtení téhož run ID mohlo zrušit aktivní appearance scope. Scope používá vlastníka konkrétního mountu a aktivaci před vykreslením grafu.
3. Částečně namontované nebo neaktivní záložky mohly přepsat uložené kresby prázdným seznamem. Checkpoint uchovává původní stav, dokud není připraven chart API i drawing engine.
4. Globální výchozí vzhled, nastavení indikátorů a kreslicích stylů používaly společné klíče napříč účty. Nové klíče jsou oddělené podle uživatele, cache se při změně identity ruší, opožděné auth odpovědi nepřepíšou aktuální identitu. Nepřiřazené staré defaults se nepřipisují přihlášenému účtu; existující uložený appearance runu zůstává zdrojem pravdy.
5. Pojmenované šablony mohly přejít mezi účty, souběžný sync mohl zahodit změny a smazané šablony se vracely ze starého zařízení. Opraveno per-user cache, serializované slučování aktuálních mutací a tombstones v existujícím JSONB. Při konfliktu názvu se používá přesné cloudové ID. Neznámé legacy šablony zůstávají zachované pro explicitní import v menu.
6. Position šablona přenášela pointValue/tickSize zdrojového instrumentu: NQ → MNQ mohl znamenat desetinásobnou chybu v množství. Zachovávají se údaje cílového grafu. Apply defaults už skutečně obnovuje výchozí preference. Fibonacci/Position změny přes OK a toolbar ukládají příslušné defaults; Cancel je nemění.
7. Automatické tagy se rozeznávaly podle prefixu, takže například ruční „u silné rezistence“ mohl zmizet. Nový explicitní původ nahradil odhad podle textu. Odebrání a ruční opětovné přidání přesune tag do ručního hodnocení.
8. Refresh objektu stejného obchodu zahodil rozepsané poznámky. Draft je nyní vázaný na ID obchodu. Během save jsou editace a zavření uzamčené; při chybě zůstává review otevřené. Přepočet blokuje paralelní změny konfluencí a uložení.
9. Coach mohl vracet zastaralý obsah embeddings, vynechávat poznámky z recent context a v podobnosti míchat live/backtest. Aktuální obsah se dohledává v příslušném světě, poznámky a tagy jsou v kontextu, při chybě sémantického hledání funguje textové.

## Ověření v prohlížeči

Izolovaný harness `/tests/qa/backtest.html`, port 4184, React StrictMode, backend mock. QA přenosy do reálných tabulek a AI jsou blokované.

- Rozepsaná česká poznámka přežila obnovení objektu stejného obchodu.
- Vlastní tag „Můj retest“ se uložil společně s poznámkou, zůstal po znovuotevření a nabídl se při dalším přidání.
- Auto „U VWAP“ byl odebrán a ručně přidán; po přepočtu zůstal ruční, vedle nového tagu „Nový auto HTF“. Starý auto Entry tag se nahradil novým.
- Simulovaná chyba save nechala review i draft otevřené; druhé uložení uspělo.
- Zapnutí levelů, nakreslení obdélníku a bezprostřední zavření: uložený run obsahoval objekt i indikátor; po Reopen saved byly oba viditelné.

## Hranice ověření a blokované části

Přenos šablon mezi skutečnými zařízeními a aktuální nasazená verze ChatGPT konektoru nebyly ověřené. Tombstone protokol očekává aktuální klienty; staré otevřené taby je nutné obnovit. Globální defaulty mimo run jsou lokální pro daný prohlížeč; run appearance a pojmenované šablony mají vlastní cloudové cesty.

Automatická kontrola oprávnění odmítla automatické odesílání upravených poznámek do embedding služby a následně i navržené úpravy MCP předávání poznámek do ChatGPT kvůli chybějícímu výslovnému souhlasu pro konkrétní data a destinaci. Obě části zůstaly beze změny. Neproběhl žádný takový přenos.

Audit současného MCP zdroje potvrzuje 60sekundovou cache a slepé oříznutí detailu na 30 000 znaků. U velkého detailu může chybět poznámka a výstup může být neplatný JSON. To se netýká opravených interních Coach nástrojů; podrobnosti a reprodukce viz `backtest-notes-tags-20260905.md`. Nasazený MCP nelze označit za spolehlivě opravený.

## Kompletní Uložit / Načíst / Export

Tlačítka nyní ukládají a obnovují verzovaný dokument `alphatrade-workspace`, version 1: rozložení panelů, kresby, indikátory, měřítka, aktivní panel, synchronizaci a vzhled. Nejde o export obchodního ledgeru nebo celého backtest runu. Pojmenovaná kopie Uložit je lokální podle účtu/session; současný run se zároveň flushne do své cloudové cesty. Status rozlišuje úspěch lokálního uložení a čekající cloud.

Import validuje JSON, verzi, strom panelů, timeframe/instrument, snapshoty i nastavení před změnou grafu. Staré samotné layouty lze explicitně načíst; UI přizná, že neobsahují kresby/vzhled. Chyby ukládání a importu se zobrazují. Automatický test pokrývá neplatné/vynechané části; prohlížeč ověřil Uložit → smazat obdélník + vypnout levely → Načíst → obdélník i levely znovu viditelné. Cloud v tomto browser testu je mock, nikoli živý důkaz.

Podrobnosti implementace layoutu a jeho omezení: `backtest-20260905/layout-verification.md`.

## Závěrečná automatická kontrola

- Celá regresní sada: 226 souborů / 1 895 testů prošlo; jediný neúspěšný test `tradovateBrokerRenewal` používá reálný 40ms deadline. Samostatně po odeznění zátěže prošel celý soubor 3/3 bez změny kódu. Broker nebyl v této práci upraven.
- Po posledním propojení workspace: cíleně 8 souborů / 49 testů prošlo. Po doplnění import guardů samostatný workspace document soubor 11/11.
- TypeScript kontrola celého projektu prošla. Produkční Vite/PWA build prošel.
- ESLint změněných produkčních souborů: 0 chyb, 54 warningů; žádný plošný autofix.
- Browser konzole při scénářích neobsahovala error ani warning. Další test potvrdil, že rozepsaný vlastní tag se uloží i přímým kliknutím na Uložit bez předchozího Enter.

Ověřené změny jsou určeny pro canonical checkout `/Users/filipkrejca/Documents/trading-journal-aka`. Žádný push nebo deploy není součástí tohoto ověření.
