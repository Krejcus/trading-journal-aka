/**
 * DailyFocusWidget — "Dnes hlídat" widget na dashboard.
 *
 * Ukáže aktivní Iron Rules + checklisty z AI Coache jako vždy-vidět připomínku.
 * User si přidává pravidla přes ActionPanel v AI Coachi (akce typu 'rule', 'experiment',
 * 'checklist'), tady je vidí na hlavní stránce při každém otevření appky.
 *
 * Detekce checklistu: rule.label začíná "📋 " a obsahuje "▢" položky → renderuje jako
 * collapsable list. Ostatní pravidla jsou one-liners.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { Target, ChevronRight, Shield, FlaskConical, FileText, Clock, Check } from 'lucide-react';
import type { IronRule } from '../types';

/**
 * Persistence pro denní odškrtávání checklistů.
 * Klíč: alphatrade_checklist_progress_<YYYY-MM-DD>
 * Value: { "<ruleId>:<itemIdx>": true, ... }
 * Stará data se po pár dnech vyčistí (cleanup pri loadu).
 */
const STORAGE_KEY_PREFIX = 'alphatrade_checklist_progress_';

function todayKey(): string {
    return STORAGE_KEY_PREFIX + new Date().toISOString().slice(0, 10);
}

function loadTodayProgress(): Record<string, boolean> {
    try {
        const raw = localStorage.getItem(todayKey());
        return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
}

function saveTodayProgress(progress: Record<string, boolean>): void {
    try {
        localStorage.setItem(todayKey(), JSON.stringify(progress));
    } catch { /* ignore quota */ }
}

/** Vyčistí progress klíče starší než 7 dní (one-shot pri load). */
function cleanupOldProgress(): void {
    try {
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i);
            if (!k || !k.startsWith(STORAGE_KEY_PREFIX)) continue;
            const dateStr = k.slice(STORAGE_KEY_PREFIX.length);
            const ts = new Date(dateStr).getTime();
            if (!isNaN(ts) && ts < cutoff) localStorage.removeItem(k);
        }
    } catch { /* ignore */ }
}

interface Props {
    ironRules: IronRule[];
    theme: 'dark' | 'light' | 'oled';
    /** Klik na "Spravovat" — naviguje do Settings */
    onManage?: () => void;
}

interface ParsedRule {
    id: string | number;
    type: 'rule' | 'experiment' | 'checklist';
    title: string;
    items?: string[];
    duration?: string;
    isActive: boolean;
}

/** Parsne label IronRule a zjistí typ + items (pro checklisty) + duration (pro experimenty). */
function parseRule(rule: IronRule): ParsedRule {
    const label = rule.label || '';

    // Checklist: "📋 <title>\n  ▢ item1\n  ▢ item2..."
    if (label.startsWith('📋 ')) {
        const lines = label.split('\n');
        const title = lines[0].replace(/^📋\s+/, '').trim();
        const items = lines
            .slice(1)
            .map(l => l.replace(/^\s*▢\s*/, '').trim())
            .filter(Boolean);
        return { id: rule.id, type: 'checklist', title, items, isActive: !!rule.isActive };
    }

    // Experiment: "⏱ [2w] <title>"
    const expMatch = label.match(/^⏱\s*\[([^\]]+)\]\s*(.+)$/);
    if (expMatch) {
        return {
            id: rule.id,
            type: 'experiment',
            title: expMatch[2].trim(),
            duration: expMatch[1],
            isActive: !!rule.isActive,
        };
    }

    // Standard rule
    return { id: rule.id, type: 'rule', title: label.trim(), isActive: !!rule.isActive };
}

const RuleIcon: React.FC<{ type: ParsedRule['type']; size?: number }> = ({ type, size = 12 }) => {
    switch (type) {
        case 'rule': return <Shield size={size} strokeWidth={2.5} />;
        case 'experiment': return <FlaskConical size={size} strokeWidth={2.5} />;
        case 'checklist': return <FileText size={size} strokeWidth={2.5} />;
    }
};

const RuleColor: Record<ParsedRule['type'], string> = {
    rule: 'blue',
    experiment: 'amber',
    checklist: 'purple',
};

const ChecklistCard: React.FC<{
    rule: ParsedRule;
    isDark: boolean;
    progress: Record<string, boolean>;
    onToggle: (itemIdx: number) => void;
}> = ({ rule, isDark, progress, onToggle }) => {
    const itemCount = rule.items?.length || 0;
    const checkedCount = (rule.items || []).filter((_, i) => progress[`${rule.id}:${i}`]).length;
    const allDone = itemCount > 0 && checkedCount === itemCount;
    // Default rozbalený dokud user neodškrtl všechno
    const [expanded, setExpanded] = useState(!allDone);

    return (
        <div className={`rounded-xl border transition-all ${
            allDone
                ? isDark ? 'bg-emerald-500/[0.05] border-emerald-500/20' : 'bg-emerald-500/[0.05] border-emerald-500/25'
                : isDark ? 'bg-purple-500/[0.04] border-purple-500/15' : 'bg-purple-500/[0.04] border-purple-500/20'
        }`}>
            <button
                onClick={() => setExpanded(!expanded)}
                className="w-full flex items-center justify-between gap-2 px-3 py-2.5 transition-all hover:bg-purple-500/[0.06]"
            >
                <div className="flex items-center gap-2 min-w-0">
                    <div className={`p-1.5 rounded-lg shrink-0 ${
                        allDone ? 'bg-emerald-500/20 text-emerald-500' : 'bg-purple-500/15 text-purple-500'
                    }`}>
                        {allDone ? <Check size={11} strokeWidth={3} /> : <FileText size={11} strokeWidth={2.5} />}
                    </div>
                    <div className="flex flex-col items-start min-w-0">
                        <span className={`text-[8px] font-black uppercase tracking-[0.2em] ${allDone ? 'text-emerald-500/80' : 'text-purple-500/80'}`}>
                            Checklist · {checkedCount}/{itemCount}
                        </span>
                        <span className={`text-[11px] font-black truncate text-left ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{rule.title}</span>
                    </div>
                </div>
                <ChevronRight size={12} className={`shrink-0 transition-transform ${allDone ? 'text-emerald-500/60' : 'text-purple-500/60'} ${expanded ? 'rotate-90' : ''}`} />
            </button>
            {expanded && rule.items && (
                <ul className={`px-4 pb-3 pt-1 space-y-1.5 border-t ${
                    allDone
                        ? isDark ? 'border-emerald-500/15' : 'border-emerald-500/20'
                        : isDark ? 'border-purple-500/10' : 'border-purple-500/15'
                }`}>
                    {rule.items.map((item, i) => {
                        const key = `${rule.id}:${i}`;
                        const checked = !!progress[key];
                        return (
                            <li key={i}>
                                <button
                                    onClick={() => onToggle(i)}
                                    className="w-full text-[10px] flex items-start gap-2 leading-snug text-left hover:bg-purple-500/[0.04] rounded-md p-1 -m-1 transition-all"
                                >
                                    <span className={`shrink-0 w-4 h-4 rounded border-[1.5px] flex items-center justify-center transition-all mt-0 ${
                                        checked
                                            ? 'bg-emerald-500 border-emerald-500'
                                            : isDark ? 'border-purple-500/40 hover:border-purple-500' : 'border-purple-500/50 hover:border-purple-500'
                                    }`}>
                                        {checked && <Check size={9} strokeWidth={4} className="text-white" />}
                                    </span>
                                    <span className={`flex-1 transition-all ${
                                        checked
                                            ? (isDark ? 'text-slate-500 line-through' : 'text-slate-400 line-through')
                                            : (isDark ? 'text-slate-300' : 'text-slate-700')
                                    }`}>{item}</span>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
};

const SimpleRuleRow: React.FC<{ rule: ParsedRule; isDark: boolean }> = ({ rule, isDark }) => {
    const color = RuleColor[rule.type];
    return (
        <div className={`flex items-center gap-2 px-3 py-2 rounded-xl border ${isDark ? `bg-${color}-500/[0.04] border-${color}-500/15` : `bg-${color}-500/[0.04] border-${color}-500/20`}`}>
            <div className={`p-1.5 rounded-lg shrink-0 bg-${color}-500/15 text-${color}-500`}>
                <RuleIcon type={rule.type} />
            </div>
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 mb-0.5">
                    <span className={`text-[7px] font-black uppercase tracking-widest text-${color}-500/80`}>
                        {rule.type === 'experiment' ? 'Experiment' : 'Iron Rule'}
                    </span>
                    {rule.duration && (
                        <span className="text-[7px] font-black uppercase tracking-widest px-1 rounded bg-amber-500/15 text-amber-600 flex items-center gap-0.5">
                            <Clock size={7} /> {rule.duration}
                        </span>
                    )}
                </div>
                <p className={`text-[11px] font-bold leading-tight ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                    {rule.title}
                </p>
            </div>
        </div>
    );
};

const DailyFocusWidget: React.FC<Props> = ({ ironRules, theme, onManage }) => {
    const isDark = theme !== 'light';

    // Daily checklist progress — keyed by today's date.
    // Load při mountu, save při každé změně. Reset každý den automaticky (date-keyed klíč).
    const [progress, setProgress] = useState<Record<string, boolean>>(() => loadTodayProgress());

    // One-time cleanup starých klíčů (>7 dnů) — neblokuje render
    useEffect(() => {
        cleanupOldProgress();
    }, []);

    const toggleItem = useCallback((ruleId: string | number, itemIdx: number) => {
        const key = `${ruleId}:${itemIdx}`;
        setProgress(prev => {
            const next = { ...prev, [key]: !prev[key] };
            // Pokud false (odškrtnutí), prostě smazat klíč aby objekt nebobtnal
            if (!next[key]) delete next[key];
            saveTodayProgress(next);
            return next;
        });
    }, []);

    const activeRules = (ironRules || [])
        .filter(r => r.isActive !== false)
        .map(parseRule);

    if (activeRules.length === 0) {
        return (
            <div className={`h-full rounded-3xl border p-5 flex flex-col items-center justify-center text-center ${isDark ? 'bg-white/[0.02] border-white/5' : 'bg-slate-50 border-slate-200'}`}>
                <Target size={28} className="text-slate-400 mb-2" />
                <p className={`text-xs font-bold ${isDark ? 'text-slate-400' : 'text-slate-600'} mb-1`}>
                    Žádná aktivní pravidla
                </p>
                <p className="text-[10px] text-slate-500 max-w-[200px]">
                    Iron Rules / checklisty z AI Coache se objeví tady jako denní připomínka.
                </p>
            </div>
        );
    }

    // Rozdělit na checklisty (každý je expandable) a one-liner pravidla
    const checklists = activeRules.filter(r => r.type === 'checklist');
    const simpleRules = activeRules.filter(r => r.type !== 'checklist');

    return (
        <div className={`h-full rounded-3xl border flex flex-col overflow-hidden ${isDark ? 'bg-white/[0.02] border-white/5' : 'bg-white border-slate-200'}`}>
            {/* Header */}
            <div className={`flex items-center justify-between px-4 py-3 border-b ${isDark ? 'border-white/5' : 'border-slate-100'}`}>
                <div className="flex items-center gap-2">
                    <div className="p-1.5 rounded-lg bg-blue-500/15 text-blue-500">
                        <Target size={14} strokeWidth={2.5} />
                    </div>
                    <div>
                        <p className={`text-[12px] font-black uppercase tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>Dnes hlídat</p>
                        <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">
                            {activeRules.length} {activeRules.length === 1 ? 'pravidlo' : activeRules.length < 5 ? 'pravidla' : 'pravidel'}
                        </p>
                    </div>
                </div>
                {onManage && (
                    <button
                        onClick={onManage}
                        className={`text-[9px] font-black uppercase tracking-widest px-2 py-1 rounded-lg transition-all ${isDark ? 'text-slate-400 hover:text-slate-200 hover:bg-white/5' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'}`}
                        title="Spravovat v Settings"
                    >
                        Spravovat
                    </button>
                )}
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2 no-scrollbar">
                {/* Checklisty první — vizuálně dominantnější */}
                {checklists.map(rule => (
                    <ChecklistCard
                        key={String(rule.id)}
                        rule={rule}
                        isDark={isDark}
                        progress={progress}
                        onToggle={(idx) => toggleItem(rule.id, idx)}
                    />
                ))}
                {simpleRules.map(rule => (
                    <SimpleRuleRow key={String(rule.id)} rule={rule} isDark={isDark} />
                ))}
            </div>
        </div>
    );
};

export default DailyFocusWidget;
