import React from 'react';
import { createRoot } from 'react-dom/client';
import RithmicLiveChart from '../../components/RithmicLiveChart';
import '../../index.css';
import { startChartDrawingLayer } from '../../services/chartDrawingLayer';
import { NO_LIVE_COPIER } from '../../lib/liveNoCopier';

import { measureSimulationLine } from './rithmic-line-timing';
import { SIMULATION_ACCOUNT_BAR, simulationAccountBarNearLimit } from './rithmic-simulation-accounts';

if (location.search === '?measure=1') measureSimulationLine();
// `?vrstva=1`: kresby jako na skutečném účtu — jedna vrstva společná pro všechny timeframy.
if (location.search.includes('vrstva=1')) {
  window.localStorage.setItem('alphatrade:chart-drawings-migrated:v1:user:qa-layer-user', 'qa');
  startChartDrawingLayer();
}
createRoot(document.getElementById('root')!).render(
  <RithmicLiveChart open isDark tabs={[]} onNavigate={() => {}} copier={NO_LIVE_COPIER} disarm={null}
    onCrash={() => {}} accountBar={location.search.includes('ucty=skutecne') ? null : location.search.includes('limit=blizko') ? simulationAccountBarNearLimit() : SIMULATION_ACCOUNT_BAR} simulationUrl={`ws://${location.host}/local-simulation${['?drop=1', '?drop=cancel'].includes(location.search) ? location.search : ''}`} />
);
