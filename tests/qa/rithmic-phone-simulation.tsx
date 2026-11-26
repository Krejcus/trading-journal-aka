// Zkušební stránka: telefonní LIVE graf (`LivePhoneChart`) nad lokální simulací Rithmicu.
// Otevři v úzkém okně: http://127.0.0.1:4186/tests/qa/rithmic-phone-simulation.html
// (server: node tests/qa/start-rithmic.mjs --simulate). Žádný skutečný účet, žádná síť mimo simulaci.
import React from 'react';
import { createRoot } from 'react-dom/client';
import RithmicPhoneChart from '../../components/RithmicPhoneChart';
import LivePhoneChart from '../../components/day/LivePhoneChart';
import { LivePhoneHeader } from '../../components/LivePhoneChrome';
import { SIMULATION_ACCOUNT_BAR, simulationAccountBarNearLimit } from './rithmic-simulation-accounts';
import '../../index.css';
import { startChartDrawingLayer } from '../../services/chartDrawingLayer';

// Stejné přepínače výpadků jako PC simulace (?drop=1, ?drop=cancel).
const query = ['?drop=1', '?drop=cancel'].includes(location.search) ? location.search : '';
const note = (text: string) => { document.title = text; };
// `?device=1`: stránka se chová jako spárované zařízení — bez předané adresy simulace, přes párování kódem
// a přihlášení klíčem zařízení (brána pro zařízení běží na portu o jedna výš než stránka).
const asDevice = location.search === '?device=1';

// `?vrstva=1`: kresby jako na skutečném účtu — jedna vrstva společná pro všechny timeframy.
if (location.search.includes('vrstva=1')) {
  window.localStorage.setItem('alphatrade:chart-drawings-migrated:v1:user:qa-layer-user', 'qa');
  startChartDrawingLayer();
}
// Přepínač světlý/tmavý jen pro zkušební stránku (appka bere motiv z nastavení).
const THEME_KEY = 'qa:rithmic-phone:theme';
function Page() {
  const [isDark, setIsDark] = React.useState(() => window.localStorage.getItem(THEME_KEY) !== 'light');
  // Stejné třídy na <html>, jaké nastavuje appka — z nich berou barvy listy a lišty.
  React.useEffect(() => {
    document.documentElement.classList.toggle('light-theme', !isDark);
    document.documentElement.classList.toggle('dark', isDark);
  }, [isDark]);
  const toggle = () => setIsDark(current => { window.localStorage.setItem(THEME_KEY, current ? 'light' : 'dark'); return !current; });
  return <>
  <button type="button" data-testid="qa-theme-toggle" onClick={toggle} aria-label={isDark ? 'Přepnout na světlý motiv' : 'Přepnout na tmavý motiv'}
    style={{ position: 'fixed', top: 'calc(env(safe-area-inset-top, 0px) + 8px)', right: 8, zIndex: 100000, height: 30, padding: '0 10px', borderRadius: 9, border: '1px solid rgba(148,163,184,.6)', background: isDark ? '#f8fafc' : '#0f172a', color: isDark ? '#0f172a' : '#f8fafc', font: '600 12px system-ui', cursor: 'pointer' }}>
    {isDark ? 'Světlý' : 'Tmavý'}
  </button>
  <RithmicPhoneChart
    open isDark={isDark}
    onLeave={() => note('Zpět na Live Dashboard (ve zkušební stránce nikam nevede)')}
    {...(asDevice ? {} : { simulationUrl: `ws://${location.host}/local-simulation${query}` })}
    accountBar={location.search.includes('ucty=skutecne') ? null : location.search.includes('limit=blizko') ? simulationAccountBarNearLimit() : SIMULATION_ACCOUNT_BAR}
    header={({ group, account, compact }) => <LivePhoneHeader groupName={null} group={group} account={account} hideCopier={compact}
      copier={{ label: 'Kopírka: zkušební stránka', tone: 'muted', armed: false }} onMenu={() => note('LIVE menu (ve zkušební stránce není)')} />}
    phoneChart={slots => <LivePhoneChart trades={[]} allTrades={[]} sessions={[]} isDark={isDark} onUpdateTrade={() => undefined} slots={slots} onLeave={slots.onLeave} />}
  />
  </>;
}
createRoot(document.getElementById('root')!).render(<Page />);
