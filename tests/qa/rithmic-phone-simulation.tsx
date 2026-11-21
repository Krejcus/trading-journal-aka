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

// Stejné přepínače výpadků jako PC simulace (?drop=1, ?drop=cancel).
const query = ['?drop=1', '?drop=cancel'].includes(location.search) ? location.search : '';
const note = (text: string) => { document.title = text; };
// `?device=1`: stránka se chová jako spárované zařízení — bez předané adresy simulace, přes párování kódem
// a přihlášení klíčem zařízení (brána pro zařízení běží na portu o jedna výš než stránka).
const asDevice = location.search === '?device=1';

createRoot(document.getElementById('root')!).render(
  <RithmicPhoneChart
    open isDark
    onLeave={() => note('Zpět na Live Dashboard (ve zkušební stránce nikam nevede)')}
    {...(asDevice ? {} : { simulationUrl: `ws://${location.host}/local-simulation${query}` })}
    accountBar={location.search.includes('limit=blizko') ? simulationAccountBarNearLimit() : SIMULATION_ACCOUNT_BAR}
    header={({ group, account, compact }) => <LivePhoneHeader groupName={null} group={group} account={account} hideCopier={compact}
      copier={{ label: 'Kopírka: zkušební stránka', tone: 'muted', armed: false }} onMenu={() => note('LIVE menu (ve zkušební stránce není)')} />}
    phoneChart={slots => <LivePhoneChart trades={[]} allTrades={[]} sessions={[]} isDark onUpdateTrade={() => undefined} slots={slots} onLeave={slots.onLeave} />}
  />
);
