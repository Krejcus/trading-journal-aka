import { useEffect, useReducer } from 'react';
import { COPIER_DISARM_NOTICE_MS, isRecentCopierDisarm } from '../lib/copierDisarmNotice';

export function useCopierDisarmNotice(at: number | undefined): boolean {
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    if (!isRecentCopierDisarm(at)) return;
    const timer = setTimeout(refresh, Math.min(2_147_483_647, Math.max(1, at! + COPIER_DISARM_NOTICE_MS - Date.now())));
    return () => clearTimeout(timer);
  }, [at]);
  return isRecentCopierDisarm(at);
}
