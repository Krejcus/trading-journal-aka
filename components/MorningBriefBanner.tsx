/**
 * MorningBriefBanner — pre-market AI brief shown atop the Dashboard.
 *
 * Behavior:
 *  - On mount, calls `/functions/v1/morning-brief` once per day (cached in localStorage).
 *  - Edge function self-gates by weekend / outside 06–14h PRG / already-traded-today,
 *    returning { brief: null, skipped } in those cases — banner stays hidden.
 *  - Dismissed banners stay hidden until the next calendar day.
 *  - Click "Rozeber v Coach" navigates to AI Coach with a pre-filled prompt.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Sparkles, X, MessageSquare, Sun, AlertTriangle, ShieldAlert } from 'lucide-react';
import { supabase } from '../services/supabase';

type Tone = 'positive' | 'caution' | 'warning';

interface BriefPayload {
  ok: boolean;
  brief: string | null;
  focusPoints?: string[];
  tone?: Tone;
  date?: string;
  skipped?: string;
}

interface Props {
  userId: string;
  theme: 'dark' | 'light' | 'oled';
  /** Called when user clicks "Rozeber v Coach" — opens AI Coach with the brief as initial prompt. */
  onOpenCoach: (initialPrompt: string) => void;
}

// localStorage helpers — separated for testability and to avoid stale-day reads.
const cacheKey = (uid: string, dateIso: string) => `mb-cache:${uid}:${dateIso}`;
const dismissKey = (uid: string, dateIso: string) => `mb-dismiss:${uid}:${dateIso}`;

function todayIsoPrague(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(new Date());
}

function readCache(uid: string): BriefPayload | null {
  try {
    const raw = localStorage.getItem(cacheKey(uid, todayIsoPrague()));
    return raw ? (JSON.parse(raw) as BriefPayload) : null;
  } catch {
    return null;
  }
}

function writeCache(uid: string, payload: BriefPayload): void {
  try {
    localStorage.setItem(cacheKey(uid, todayIsoPrague()), JSON.stringify(payload));
  } catch { /* quota/private mode — silently skip */ }
}

function isDismissed(uid: string): boolean {
  try {
    return localStorage.getItem(dismissKey(uid, todayIsoPrague())) === '1';
  } catch {
    return false;
  }
}

function markDismissed(uid: string): void {
  try {
    localStorage.setItem(dismissKey(uid, todayIsoPrague()), '1');
  } catch { /* ignore */ }
}

const TONE_STYLE: Record<Tone, { wrap: string; icon: any; iconColor: string; label: string }> = {
  positive: {
    wrap: 'border-emerald-500/30 bg-emerald-500/5',
    icon: Sun,
    iconColor: 'text-emerald-500',
    label: 'Pre-market brief',
  },
  caution: {
    wrap: 'border-amber-500/40 bg-amber-500/8',
    icon: AlertTriangle,
    iconColor: 'text-amber-500',
    label: 'Pre-market brief — pozor',
  },
  warning: {
    wrap: 'border-rose-500/50 bg-rose-500/8',
    icon: ShieldAlert,
    iconColor: 'text-rose-500',
    label: 'Pre-market brief — varování',
  },
};

const MorningBriefBanner: React.FC<Props> = ({ userId, theme, onOpenCoach }) => {
  const isDark = theme !== 'light';
  const [payload, setPayload] = useState<BriefPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [dismissed, setDismissed] = useState<boolean>(() => isDismissed(userId));

  // Single-shot fetch: cache → fetch → render.
  useEffect(() => {
    if (!userId) return;
    // 1) prefer today's cache (skip network round-trip on re-mount)
    const cached = readCache(userId);
    if (cached) {
      setPayload(cached);
      return;
    }
    // 2) fetch from edge function
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return;
        const baseUrl = (supabase as any).supabaseUrl || (import.meta as any).env?.VITE_SUPABASE_URL || '';
        const res = await fetch(`${baseUrl}/functions/v1/morning-brief`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
        });
        const data = await res.json();
        if (cancelled) return;
        if (res.ok) {
          setPayload(data);
          writeCache(userId, data);
        }
      } catch (e) {
        // Network/parse error — silent. Banner stays hidden, no nag.
        console.warn('[MorningBrief] fetch failed:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [userId]);

  const tone: Tone = (payload?.tone as Tone) || 'positive';
  const style = TONE_STYLE[tone];
  const Icon = style.icon;

  const initialPrompt = useMemo(() => {
    if (!payload?.brief) return '';
    const bullets = (payload.focusPoints || []).map(p => `- ${p}`).join('\n');
    return `Probereme dnešní pre-market brief detailně.\n\nBrief: ${payload.brief}\n\nFocus pointy:\n${bullets || '- (žádné specifické)'}\n\nJak konkrétně mám dnes přistoupit k trades?`;
  }, [payload]);

  // Hide states — silent when there's nothing to say.
  if (!userId) return null;
  if (dismissed) return null;
  if (!payload || !payload.brief) return null;

  const handleDismiss = () => {
    markDismissed(userId);
    setDismissed(true);
  };

  return (
    <AnimatePresence>
      <motion.div
        key="morning-brief"
        initial={{ opacity: 0, y: -12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -12, scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 380, damping: 32 }}
        className={`relative rounded-2xl border p-4 sm:p-5 ${style.wrap} ${isDark ? 'shadow-2xl' : 'shadow-md'} mb-6`}
      >
        <button
          onClick={handleDismiss}
          className="absolute top-3 right-3 p-1.5 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-white/5 transition-all"
          title="Skrýt do zítřka"
        >
          <X size={14} />
        </button>

        <div className="flex items-start gap-3 sm:gap-4">
          <div className={`p-2 rounded-xl ${isDark ? 'bg-white/5' : 'bg-white/60'} shrink-0`}>
            <Icon size={18} className={style.iconColor} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles size={11} className={style.iconColor} />
              <span className={`text-[9px] font-black uppercase tracking-[0.2em] ${style.iconColor}`}>
                {style.label}
              </span>
            </div>

            <p className={`text-sm leading-relaxed mb-3 ${isDark ? 'text-white' : 'text-slate-900'}`}>
              {payload.brief}
            </p>

            {payload.focusPoints && payload.focusPoints.length > 0 && (
              <div className="mb-4 space-y-1.5">
                {payload.focusPoints.map((point, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span className={`shrink-0 mt-1.5 w-1 h-1 rounded-full ${style.iconColor.replace('text-', 'bg-')}`} />
                    <span className={`text-xs ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{point}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-wrap gap-2 pr-6">
              <button
                onClick={() => onOpenCoach(initialPrompt)}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-black uppercase tracking-widest shadow-md shadow-blue-600/20 transition-all active:scale-95"
              >
                <MessageSquare size={11} />
                Rozeber v Coach
              </button>
              <button
                onClick={handleDismiss}
                className={`px-3.5 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all active:scale-95 ${
                  isDark ? 'bg-white/5 hover:bg-white/10 text-slate-300' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'
                }`}
              >
                OK, dnes jedu
              </button>
              {loading && <span className="text-[9px] text-slate-500 self-center">načítám…</span>}
            </div>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
};

export default MorningBriefBanner;
