/** Native recurring session/audit reminders are owned by the local iOS planner. */
export function shouldSendNativeScheduledAlert(type: string): boolean {
  return !type.startsWith('session-') && type !== 'evening-audit';
}

/** The UI preference means audit ten minutes AFTER the session, including midnight rollover. */
export function isSessionEndAuditTime(currentMinute: number, sessionEndMinute: number): boolean {
  const target = (sessionEndMinute + 10) % 1440;
  const delta = Math.abs(currentMinute - target);
  return Math.min(delta, 1440 - delta) <= 1;
}
