// Zkušební stránka: obrazovka kopírky Rithmic (PC) nad simulací v prohlížeči. `?phone=1` = telefonní rozvržení.
// http://127.0.0.1:4196/tests/qa/rithmic-copier.html   ·   …/rithmic-copier.html?phone=1 (v úzkém okně)
import React from 'react';
import { createRoot } from 'react-dom/client';
import { RithmicCopierPhone, RithmicCopierScreen } from '../../components/copier/RithmicCopierScreen';
import { SimBar, useCopierSimulation } from './rithmic-copier-sim';
import RithmicCopierTab from '../../components/copier/RithmicCopierTab';
import '../../index.css';

// `?service=1`: záložka LIVE „Kopírka“ nad lokální simulací služby Rithmic (účet LOCAL-SIM, jen čtení).
function ServicePage() {
  const phone = location.search.includes('phone=1');
  return (
    <div style={{ minHeight: '100vh', background: 'radial-gradient(1200px 600px at 20% -10%,#1e1b4b 0%,#0b1020 45%,#060913 100%)' }}>
      <div style={{ maxWidth: phone ? 430 : 1240, margin: '0 auto' }}><RithmicCopierTab open narrow={phone} isDark simulationUrl={`ws://${location.host}/local-simulation`} /></div>
    </div>
  );
}

function Page() {
  const { view, actions, sim } = useCopierSimulation();
  const phone = location.search.includes('phone=1');
  const light = location.search.includes('light=1');
  return (
    <div style={{ minHeight: '100vh', background: light ? '#f1f5f9' : 'radial-gradient(1200px 600px at 20% -10%,#1e1b4b 0%,#0b1020 45%,#060913 100%)' }}>
      {phone
        ? <div style={{ maxWidth: 430, margin: '0 auto' }}><RithmicCopierPhone view={view} actions={actions} isDark={!light} /></div>
        : <div style={{ maxWidth: 1240, margin: '0 auto' }}><RithmicCopierScreen view={view} actions={actions} isDark={!light} /></div>}
      <SimBar sim={sim} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(location.search.includes('service=1') ? <ServicePage /> : <Page />);
