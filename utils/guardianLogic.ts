import { DailyPrep, DailyReview, SessionConfig, SystemSettings } from '../types';

export interface GuardianState {
    isCriticalAlert: boolean;
    isPrepMissing: boolean;
    activeSession: SessionConfig | null;
    nextSession: { session: SessionConfig; minutesToStart: number } | null;
    isDebtActive: boolean;
    showMorningIntervention: boolean;
    showEveningIntervention: boolean;
}

/**
 * Returns the current date in YYYY-MM-DD format based on local time
 */
export const getTodayStr = (date: Date = new Date()) => {
    const d = new Date(date.getTime() - (date.getTimezoneOffset() * 60000));
    return d.toISOString().split('T')[0];
};

/**
 * Parses "HH:mm" time string into minutes from start of day
 */
const parseTimeToMinutes = (timeStr: string) => {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
};

export const getGuardianState = (
    settings: SystemSettings,
    sessions: SessionConfig[],
    preps: DailyPrep[],
    reviews: DailyReview[],
    currentTime: Date = new Date()
): GuardianState => {
    const todayStr = getTodayStr(currentTime);
    const currentMinutes = currentTime.getHours() * 60 + currentTime.getMinutes();

    // 1. Check for Prep Today
    const hasPrepToday = preps.some(p => p.date === todayStr);
    const hasReviewToday = reviews.some(r => r.date === todayStr);

    // 2. Detect Active/Upcoming Session
    let activeSession: SessionConfig | null = null;
    let nextSession: { session: SessionConfig; minutesToStart: number } | null = null;

    sessions.forEach(s => {
        const start = parseTimeToMinutes(s.startTime);
        const end = parseTimeToMinutes(s.endTime);

        const isOvernight = end < start;
        const isActive = isOvernight
            ? (currentMinutes >= start || currentMinutes < end)
            : (currentMinutes >= start && currentMinutes < end);

        if (isActive) {
            activeSession = s;
        } else {
            let diff = start - currentMinutes;
            if (diff < 0) diff += 24 * 60; // Next day

            if (!nextSession || diff < nextSession.minutesToStart) {
                nextSession = { session: s, minutesToStart: diff };
            }
        }
    });

    // 3. Intervention Logic
    const isWithinMorningWindow = (nextSession && nextSession.minutesToStart <= 60) || !!activeSession;
    const showMorningIntervention = settings.guardianEnabled && !hasPrepToday && isWithinMorningWindow;

    const eveningLimit = parseTimeToMinutes(settings.eveningAuditAlertTime || '20:00');
    const showEveningIntervention = settings.eveningAuditAlertEnabled && !hasReviewToday && currentMinutes >= eveningLimit;

    // 4. Critical Alert Logic (Legacy Strips)
    const isStartingSoon = nextSession && nextSession.minutesToStart <= 15;
    const isCriticalAlert = (settings.guardianEnabled &&
        settings.morningPrepAlertCritical &&
        !hasPrepToday &&
        (!!activeSession || isStartingSoon)) || !!settings.testModeEnabled;

    // 5. Debt Logic
    const pastPreps = preps
        .filter(p => p.date < todayStr)
        .sort((a, b) => b.date.localeCompare(a.date));

    let isDebtActive = false;
    if (settings.morningWakeUpDebtAlert && pastPreps.length > 0) {
        const lastTradingDay = pastPreps[0].date;
        const hasReviewForLastDay = reviews.some(r => r.date === lastTradingDay);
        if (!hasReviewForLastDay) {
            isDebtActive = true;
        }
    }

    return {
        isCriticalAlert,
        isPrepMissing: !hasPrepToday,
        activeSession,
        nextSession,
        isDebtActive,
        showMorningIntervention,
        showEveningIntervention
    };
};
