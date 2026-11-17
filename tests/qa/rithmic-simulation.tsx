import React from 'react';
import { createRoot } from 'react-dom/client';
import RithmicLiveChart from '../../components/RithmicLiveChart';
import '../../index.css';

const copier = { status: null, available: false, pending: false, transport: 'local' as const, reconnectRequired: 0 };
createRoot(document.getElementById('root')!).render(
  <RithmicLiveChart open isDark tabs={[]} onNavigate={() => {}} copier={copier} disarm={null}
    onCrash={() => {}} simulationUrl={`ws://${location.host}/local-simulation`} />
);
