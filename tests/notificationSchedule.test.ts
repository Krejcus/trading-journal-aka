import { describe, expect, it } from 'vitest';
import { isSessionEndAuditTime, shouldSendNativeScheduledAlert } from '../server/notificationSchedule';

describe('server notification schedule ownership', () => {
  it('leaves recurring iOS session/audit delivery to the local planner', () => {
    for (const type of ['session-t15-ny', 'session-start-ny', 'session-end10-ny', 'session-end-ny', 'evening-audit']) {
      expect(shouldSendNativeScheduledAlert(type)).toBe(false);
    }
    expect(shouldSendNativeScheduledAlert('guardian-t15')).toBe(true);
    expect(shouldSendNativeScheduledAlert('social-trade-123')).toBe(true);
  });
  it('sends end10 audit after the session and handles midnight', () => {
    expect(isSessionEndAuditTime(21 * 60 + 50, 22 * 60)).toBe(false);
    expect(isSessionEndAuditTime(22 * 60 + 10, 22 * 60)).toBe(true);
    expect(isSessionEndAuditTime(5, 23 * 60 + 55)).toBe(true);
    expect(isSessionEndAuditTime(1439, 23 * 60 + 50)).toBe(true);
  });
});
