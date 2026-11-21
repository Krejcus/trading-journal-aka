import React from 'react';
import { createRoot } from 'react-dom/client';
import RithmicLiveChart from '../../components/RithmicLiveChart';
import '../../index.css';

import { measureSimulationLine } from './rithmic-line-timing';
import { SIMULATION_ACCOUNT_BAR, simulationAccountBarNearLimit } from './rithmic-simulation-accounts';

if (location.search === '?measure=1') measureSimulationLine();
const copier = { status: null, available: false, pending: false, transport: 'local' as const, reconnectRequired: 0 };
createRoot(document.getElementById('root')!).render(
  <RithmicLiveChart open isDark tabs={[]} onNavigate={() => {}} copier={copier} disarm={null}
    onCrash={() => {}} accountBar={location.search.includes('limit=blizko') ? simulationAccountBarNearLimit() : SIMULATION_ACCOUNT_BAR} simulationUrl={`ws://${location.host}/local-simulation${['?drop=1', '?drop=cancel'].includes(location.search) ? location.search : ''}`} />
);
