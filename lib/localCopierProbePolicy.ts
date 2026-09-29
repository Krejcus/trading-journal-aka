export const LOCAL_COPIER_REPROBE_BACKOFF_MS = 20_000;

export function shouldProbeLocalCopierAgent(input: {
  nativeBuild: boolean;
  state: 'unknown' | 'available' | 'unavailable';
  now: number;
  lastAttemptAt: number | null;
  resumedFromHidden?: boolean;
  backoffMs?: number;
}): boolean {
  if (input.nativeBuild) return false;
  if (input.state !== 'unavailable' || input.resumedFromHidden) return true;
  if (input.lastAttemptAt == null) return true;
  return input.now - input.lastAttemptAt >= (input.backoffMs ?? LOCAL_COPIER_REPROBE_BACKOFF_MS);
}
