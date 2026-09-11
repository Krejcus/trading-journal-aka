import type { CopierControllerStatus } from './copierRuntimeController';

export interface CopierCooldownInput {
  cooldownUntil: number;
  cooldownMinutes: number;
  pause: CopierControllerStatus['pause'];
  status: CopierControllerStatus | null;
  known: boolean;
}

const pauseNames = {
  'losing-trades': 'Pauza po ztrátě',
  'daily-loss': 'Pauza kvůli denní ztrátě',
  'max-trades': 'Pauza po limitu obchodů',
  'window-end': 'Pauza po obchodním okně',
} as const;

const timestamp = (value: number | undefined): number => Number.isFinite(value) && Number(value) > 0 ? Number(value) : 0;

export function copierPauseDeadline(cooldownUntil: number, pauseUntil?: number): number {
  return Math.max(timestamp(cooldownUntil), timestamp(pauseUntil));
}

export function formatCopierCountdown(seconds: number): string {
  const safe = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

export function buildCopierCooldownDisplay(input: CopierCooldownInput, now: number) {
  const cooldownUntil = timestamp(input.cooldownUntil);
  const pauseUntil = timestamp(input.pause?.until);
  const until = copierPauseDeadline(cooldownUntil, pauseUntil);
  const active = until > now;
  const pauseWins = pauseUntil >= cooldownUntil && pauseUntil > 0;
  const durationMs = pauseWins
    ? Math.max(0, pauseUntil - timestamp(input.pause?.at))
    : Math.max(0, input.cooldownMinutes * 60_000);
  const seconds = Math.max(0, Math.ceil((until - now) / 1000));
  const status = input.status;
  const known = input.known && status != null;
  const blocker = !known ? 'Stav workeru není ověřený.'
    : status.killSwitch ? 'Zapnutí blokuje kill switch.'
      : (status.dayLockUntil ?? 0) > now ? 'Den zůstává zamčený.'
        : !status.connected ? 'Spojení s brokerem není potvrzené.'
          : status.stuckOutbox || status.reconciliationRequired || status.divergentAccounts.length > 0
            ? 'Před dalším zapnutím je nutná kontrola účtů.'
            : null;
  const subtitle = blocker ?? (active ? 'Nové vstupy se nekopírují.'
    : status?.armed ? (status.shadowMode ? 'Worker je ve sledovacím režimu, příkazy neodesílá.' : 'Další kopírování řídí aktuální stav workeru.')
      : 'Kopírka zůstává vypnutá. Sama se nezapne.');
  return {
    until, active, seconds, durationMs, known, blocker,
    title: active ? (pauseWins ? pauseNames[input.pause!.rule] ?? 'Pauza pravidel dne' : 'Cooldown po obchodu') : 'Čas pauzy uplynul',
    subtitle,
    progress: durationMs > 0 ? Math.min(1, Math.max(0, 1 - Math.max(0, until - now) / durationMs)) : null,
    cooldown: { until: cooldownUntil, active: cooldownUntil > now, minutes: input.cooldownMinutes },
    pause: { until: pauseUntil, active: pauseUntil > now, minutes: input.pause && pauseUntil > input.pause.at ? Math.round((pauseUntil - input.pause.at) / 60_000) : null },
  };
}
