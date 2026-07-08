/**
 * featureGating — centrální definice toho, kdo na co má přístup.
 *
 * Role:
 *   - 'owner'  : plný přístup (ty)
 *   - 'friend' : default — limitovaný přístup (kamarád, každý nový uživatel)
 *
 * `LOCKED_FOR_FRIEND` jsou page ID kterými je `Sidebar` / `BottomNav` indexovaný.
 * Tab zůstává viditelný, ale na klik se otevře `LockedFeatureModal` místo navigace.
 *
 * Bezpečnost: gating v UI je jen UX — skutečná data isolation je v Supabase RLS
 * (kde každý user vidí jen své řádky). Locked feature pro friend roli nicméně
 * znemožní generování AI nákladů, otevření Insights které čtou z trades atd.
 */
import type { UserRole } from '../types';

/** Pages locked pro friend roli (visible ale neklikatelné — show modal) */
export const LOCKED_FOR_FRIEND: readonly string[] = [
    'insights',
    'lab',
    'ai',
    'business',
    'network',
];

/** Vrátí true pokud má role plný přístup k feature */
export function canAccess(featureId: string, role: UserRole | undefined): boolean {
    if (role === 'owner') return true;
    return !LOCKED_FOR_FRIEND.includes(featureId);
}

/** Vrátí true pokud má být feature zobrazena s lock vizualizací (visible but locked) */
export function isLocked(featureId: string, role: UserRole | undefined): boolean {
    return !canAccess(featureId, role);
}

/** Human-readable popisy pro lock modal */
export const FEATURE_DESCRIPTIONS: Record<string, { name: string; description: string }> = {
    insights: {
        name: 'Insights',
        description: 'Hloubková analýza patternů — kdy obchoduješ nejlépe, které setupy ti vydělávají, kde děláš opakované chyby.',
    },
    lab: {
        name: 'Lab',
        description: 'Analytická laboratoř — counterfactual srovnání SL/TP variant, bias analýza, deterministické leak detektory a experimenty nad tvými obchody.',
    },
    ai: {
        name: 'AI Coach',
        description: 'AI mentor co čte tvoje trades, dává konkrétní akční doporučení, generuje pravidla a experimenty.',
    },
    business: {
        name: 'Business Hub',
        description: 'Trading jako byznys — playbook, P&L účetnictví, payouts, daňový reporting, kariérní roadmap.',
    },
    network: {
        name: 'Network',
        description: 'Sledování ostatních traderů, sdílení obchodů, real-time notifikace na cizí aktivity.',
    },
};
