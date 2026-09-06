# Reprodukční evidence

Diagnostické skripty jsou uložené jako `.ts.txt` / `.cjs.txt`, aby se nestaly součástí automatického test discovery ani aplikačního buildu. Obsah je původní; pro opakování je nutné zkopírovat je do samostatného dočasného adresáře a odstranit příponu `.txt`. Používají absolutní cestu ke canonical checkoutu a jeho nainstalovaným závislostem. Nejsou samostatně přenosný balíček.

- `engine/existing-targeted-tests.log`: přesný command a 7 souborů / 127 existujících testů, nově spuštěné při archivaci evidence.
- `engine/results.log`: 2 soubory / 10 diagnostických testů, které potvrzují současné vadné chování. Nejde o očekávaný stav po opravě.
- `engine/tests/`: reprodukce výpočtů; `monte-carlo-extracted.ts.txt` obsahuje přesné pomocné funkce vyjmuté z komponenty, protože nejsou exportované.
- `engine/source-hashes.json`: SHA-256 devíti relevantních zdrojů.
- `persistence/backtest-second-persistence-results.log`: 3 skripty, všechny exit0, skutečné funkce a mockované úložiště/transport.
- `persistence/backtest-second-persistence-hashes.json`: SHA-256 zdrojů a skriptů, stejný stav před i po reprodukcích.
- `persistence/alphatrade-mcp-notes-audit.cjs.txt`: přiložená reprodukce dříve známého oříznutí MCP detailu; není zahrnuta do počtu tří nových persistence skriptů ani do 127 testů.

Při finální kontrole se všech 20 unikátních zdrojů z obou hash seznamů shodovalo s canonical soubory. Syntetický browser průchod je popsaný v `../browser.md`.

Node reprodukce běží bez produkční konfigurace, některé importy proto vypisují chybějící Supabase konfiguraci a náhradu browser localStorage pamětí. Tyto inicializační zprávy nejsou výsledkem testu produkčního připojení. Browser QA má vlastní explicitní mock a síťovou hranici.
