import { useEffect, useState } from 'react';
import { LIVE_CONFIRM_WINDOW_MS, type LiveConfirmState } from '../lib/liveBareEntry';
import { createLiveConfirmGate, type LiveConfirmGate, type LiveConfirmTarget } from '../lib/liveConfirmGate';

/**
 * Tenké napojení `createLiveConfirmGate` na React (C7/C8, 4. 11. 2026): automat drží stav
 * synchronně (dva kliky v jednom snímku nic nepošlou), React stav jen překresluje „Opravdu?“.
 * Rozběhnuté potvrzení zmizí po 4 s a hned, když cíl s jeho klíčem zmizí nebo se zablokuje
 * (`sync` při každé změně klíče / `enabled` některého cíle) — i bez kliku.
 */
export function useLiveConfirmGate(targets: ReadonlyArray<LiveConfirmTarget | null | undefined>): { gate: LiveConfirmGate; confirm: LiveConfirmState | null } {
  const [confirm, setConfirm] = useState<LiveConfirmState | null>(null);
  const [gate] = useState(() => createLiveConfirmGate({ onChange: setConfirm }));
  useEffect(() => {
    if (!confirm) return undefined;
    const timer = window.setTimeout(() => gate.expire(), Math.max(0, confirm.at + LIVE_CONFIRM_WINDOW_MS - Date.now()) + 5);
    return () => window.clearTimeout(timer);
  }, [confirm, gate]);
  const syncKey = targets.map(target => (target ? `${target.enabled ? 1 : 0}:${target.key}` : '-')).join('|');
  useEffect(() => { gate.sync(targets); }, [syncKey, gate]); // eslint-disable-line react-hooks/exhaustive-deps
  return { gate, confirm };
}
