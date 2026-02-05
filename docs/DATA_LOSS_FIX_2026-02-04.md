# KRITICKÁ OPRAVA - Ztráta dat při ukládání (02/04/2026)

## 🚨 Problém
Aplikace ztrácela uložená data (výplaty, náklady, analýzy, denní přípravy atd.) po aktualizaci stránky nebo po chvíli používání.

## 🔍 Příčina (3 kritické chyby)

### 1. **getPreferences() necachoval svěží data**
- `storageService.getPreferences()` načítal data z Supabase, ale **NEUKLÁDAL** je do localStorage cache
- Při reload stránky se načetla STARÁ verze z localStorage
- **Oprava**: Přidán `safeSetItem(localKey, data.preferences)` po každém fetchi z Supabase

### 2. **Dirty flag se nikdy neresetoval (preferences)**
- Když uživatel upravil data (např. přidal výplatu), nastavil se `isPreferencesDirty.current = true`
- Flag se resetoval až **PO** uložení do Supabase (`.then(() => { isPreferencesDirty = false })`)
- **Mezitím** probíhal background sync, který volal `applyPreferences(dbPrefs)`
- `applyPreferences()` kontroloval dirty flag a když byl `true`, **PŘESKOČIL** načtení nových dat
- Background sync pak přepsal stav STARÝMI daty z cache

**Oprava**:
```typescript
// PŘED (špatně):
storageService.savePreferences(data).then(() => {
  isPreferencesDirty.current = false; // Příliš pozdě!
});

// PO (správně):
isPreferencesDirty.current = false; // Hned na začátku
storageService.savePreferences(data).catch(err => {
  isPreferencesDirty.current = true; // Rollback při chybě
});
```

### 3. **Dirty flag se nikdy neresetoval (journal)**
- Stejný problém jako u preferences, ale pro `dailyPreps` a `dailyReviews`
- `isJournalDirty` se nastavoval při úpravě, ale **NIKDY** se nečistil
- Background sync pak trvale přeskakoval synchronizaci denních příprav/recenzí

**Oprava**: Stejná logika jako u preferences - čistit flag PŘED uložením, ne PO.

## ✅ Řešení

### Soubory upraveny:
1. **services/storageService.ts** (řádek 687-697)
   - `getPreferences()` nyní správně cachuje fresh data do localStorage

2. **App.tsx** (řádky 949-973, 997-1022)
   - Opravena logika dirty flags pro preferences i journal
   - Flags se nyní čistí PŘED uložením, ne po něm
   - Přidán error rollback - pokud uložení selže, flag se vrátí na `true`

## 🧪 Testování
1. ✅ Přidat výplatu → reload → výplata by měla zůstat
2. ✅ Přidat denní přípravu → reload → příprava by měla zůstat
3. ✅ Přidat náklad → počkat 5s → reload → náklad by měl zůstat
4. ✅ Přidat goal → přepnout na jinou stránku → vrátit se → goal by měl být vidět

## 📝 Poznámky
- Problém byl způsoben **race condition** mezi ukládáním dat a background syncem
- localStorage cache nebyl synchronizovaný s Supabase daty
- Dirty flags měly špatnou logiku časování

## 🔒 Doporučení
- Monitorovat console logy: `[Sync] Skipping preferences sync (dirty state)`
  - Pokud se tato zpráva objevuje často, může to indikovat problémy s timing
- Pri debug: zkontrolovat `isPreferencesDirty.current` a `isJournalDirty.current` hodnoty
