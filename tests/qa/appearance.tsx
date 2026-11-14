// QA stránka bez přihlášení: skutečné pozadí aplikace + Nastavení → Vzhled.
// Stav se nikam neukládá. ?light = světlé téma, ?bg=candles apod. = výchozí pozadí.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import AppBackground from '../../components/AppBackground';
import AppearanceSettings from '../../components/AppearanceSettings';
import { normalizeAppearance, type AppearanceSettings as Appearance } from '../../lib/appearance';
import '../../index.css';

type Theme = 'dark' | 'light' | 'oled';
const params = new URLSearchParams(location.search);

function Page() {
  const [theme, setTheme] = useState<Theme>(params.has('light') ? 'light' : 'dark');
  const [appearance, setAppearance] = useState<Appearance>(() => normalizeAppearance({
    background: params.get('bg') ?? 'depths',
    ...(params.has('speed') ? { speed: Number(params.get('speed')) } : {}),
    mouseEffect: params.get('mouse') ?? 'none',
  }));
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('light-theme', theme === 'light');
    root.classList.toggle('oled-theme', theme === 'oled');
    root.classList.toggle('aurora', theme !== 'oled');
    root.style.setProperty('--aurora-card-opacity', `${100 - appearance.cardTransparency}%`);
    root.style.setProperty('--aurora-strength', String(appearance.strength / 100));
    document.body.dataset.appearance = JSON.stringify(appearance);
  }, [appearance, theme]);
  return (
    <>
      {theme !== 'oled' && <AppBackground settings={appearance} dark={theme !== 'light'} />}
      <main style={{ minHeight: '100vh', padding: 24 }}>
        <AppearanceSettings appearance={appearance} onChange={next => setAppearance(normalizeAppearance(next))} theme={theme} onThemeChange={setTheme} />
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Page />);
