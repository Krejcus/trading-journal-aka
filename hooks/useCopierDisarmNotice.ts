import { useEffect, useReducer } from 'react';
import { COPIER_DISARM_NOTICE_MS, isRecentCopierDisarm } from '../lib/copierDisarmNotice';
import { resolveCopierDisarmRecord, type CopierDisarmRecord } from '../lib/copierDisarmReason';

export function useCopierDisarmNotice(
  record: CopierDisarmRecord | undefined,
  lastError?: string | null,
): CopierDisarmRecord | null {
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  const resolved = resolveCopierDisarmRecord(record, lastError);
  const at = resolved?.at;
  useEffect(() => {
    if (!isRecentCopierDisarm(at)) return;
    const timer = setTimeout(refresh, Math.min(2_147_483_647, Math.max(1, at! + COPIER_DISARM_NOTICE_MS - Date.now())));
    return () => clearTimeout(timer);
  }, [at]);
  return isRecentCopierDisarm(at) ? resolved ?? null : null;
}
