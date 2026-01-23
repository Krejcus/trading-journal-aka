# PWA Update System

## Jak funguje Update Banner

Aplikace automaticky detekuje novou verzi a zobrazí update banner nahoře na obrazovce.

### Typy updatů:

#### 1. **Soft Update (výchozí)**
- 🎉 Modrý banner s gradientem
- ✅ Uživatel může kliknout "Aktualizovat teď"
- ❌ Nebo zavřít (X) a updatovat později
- Použití: Běžné updates, nové funkce, UI změny, bugfixy

#### 2. **Force Update (kritické)**
- 🔒 Červený banner
- ✅ Pouze tlačítko "Aktualizovat"
- ❌ Nelze zavřít, musí aktualizovat
- Použití: Breaking API changes, kritické bezpečnostní bugfixy

---

## Jak zapnout Force Update

### Varianta A: V kódu (doporučeno)

Otevři `index.tsx` a změň:

```typescript
// Najdi tuhle řádku:
forceUpdate = false;

// Změň na:
forceUpdate = true;
```

Pak build a deploy:
```bash
npm run build
npx vercel --prod
```

### Varianta B: Environment variable (budoucí)

Můžeme přidat:
```bash
VITE_FORCE_UPDATE=true npm run build
```

A v kódu:
```typescript
forceUpdate = import.meta.env.VITE_FORCE_UPDATE === 'true';
```

---

## Testování Update Banneru

### Jak vyzkoušet na vlastním telefonu:

1. **Deploy aktuální verzi**
   ```bash
   npm run build
   npx vercel --prod
   ```

2. **Otevři aplikaci na telefonu** a počkej 10 sekund (Service Worker se zaregistruje)

3. **Udělej změnu v kódu** (např. změň text v App.tsx)

4. **Deploy novou verzi**
   ```bash
   npm run build
   npx vercel --prod
   ```

5. **Otevři aplikaci znovu** (nebo ji zavři a otevři)
   - Service Worker detekuje novou verzi
   - Banner se zobrazí nahoře
   - Klikni "Aktualizovat" → app se refreshne na novou verzi

---

## Poznámky

- **Auto-refresh delay**: Banner se zobrazí cca 5-10 sekund po otevření (Service Worker checkuje update na pozadí)
- **iOS Safari**: Může trvat až 30 sekund, než Safari detekuje novou verzi
- **Force quit**: Po force quit může detekce trvat déle (iOS omezení)

---

## Troubleshooting

### Banner se nezobrazuje:

1. Zkontroluj konzoli: `[PWA] New version available!`
2. Pokud vidíš → banner by se měl zobrazit
3. Pokud ne → Service Worker se možná nezaregistroval:
   - Hard refresh (Cmd+Shift+R)
   - Vymaž cache
   - Reinstaluj PWA na plochu

### Banner se zobrazuje při každém otevření:

- Service Worker cache není správně aktualizován
- Zkus zvýšit verzi v `vite.config.ts`:
  ```typescript
  VitePWA({
    workbox: {
      runtimeCaching: [
        // ... config
      ]
    }
  })
  ```
