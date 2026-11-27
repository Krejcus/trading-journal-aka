import React, { createContext, useCallback, useEffect, useMemo, useState } from 'react';
import { useRithmicLocalTrading } from '../hooks/useRithmicLocalTrading';
import { rithmicLocalAuth, rithmicLocalUrl } from '../lib/rithmicLocalLink';
import { onRithmicDeviceLinkRestored } from '../lib/rithmicDeviceLink';

export function usePhoneSession(open: boolean, simulationUrl?: string) {
  const [version, setVersion] = useState(0);
  const refreshPairing = useCallback(() => setVersion(value => value + 1), []);
  // Spárování obnovené z Klíčenky (po přeinstalování) doběhne až po prvním vykreslení — pak si ho přečíst znovu.
  useEffect(() => onRithmicDeviceLinkRestored(refreshPairing), [refreshPairing]);
  const url = useMemo(() => simulationUrl ?? rithmicLocalUrl(), [simulationUrl, version]);
  const deviceAuth = useMemo(() => (simulationUrl ? null : rithmicLocalAuth()), [simulationUrl, version]);
  const trading = useRithmicLocalTrading({ url, enabled: open, auth: deviceAuth });
  return { url, deviceAuth, trading, refreshPairing };
}

export const PhoneSessionContext = createContext<(ReturnType<typeof usePhoneSession> & {
  setChartOpen: (open: boolean) => void;
}) | null>(null);

export function RithmicPhoneSession({ children, livePage }: { children: React.ReactNode; livePage: boolean }) {
  const [chartOpen, setChartOpen] = useState(false);
  const [starting, setStarting] = useState(true);
  useEffect(() => {
    if (!starting) return;
    if (chartOpen) { setStarting(false); return; }
    // A restored LIVE page can open on the dashboard instead of mounting the chart.
    const timer = setTimeout(() => setStarting(false), 10_000);
    return () => clearTimeout(timer);
  }, [starting, chartOpen]);
  const session = usePhoneSession(livePage && (starting || chartOpen));
  return <PhoneSessionContext.Provider value={{ ...session, setChartOpen }}>{children}</PhoneSessionContext.Provider>;
}
