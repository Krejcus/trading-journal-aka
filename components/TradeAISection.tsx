import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Sparkles, ChevronDown, ChevronUp, Check, X as XIcon, Send, Loader2, MessageCircle } from 'lucide-react';
import { supabase } from '../services/supabase';
import type { Trade } from '../types';

interface AISuggestion {
    value: string;
    reasoning: string;
}

interface AISuggestionsBlob {
    htf?: AISuggestion[];
    ltf?: AISuggestion[];
    mistakes?: AISuggestion[];
    emotions?: AISuggestion[];
    summary?: string;
    generatedAt?: string;
    unreviewed?: boolean;
}

interface ChatMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    created_at: string;
    /** Pokud AI navrhuje úpravu tagů, dorazí strukturovaný popis */
    suggestionsUpdate?: SuggestionsUpdate | null;
}

interface SuggestionsUpdate {
    remove: Array<{ type: 'htf' | 'ltf' | 'mistake' | 'emotion'; value: string }>;
    add: Array<{ type: 'htf' | 'ltf' | 'mistake' | 'emotion'; value: string; reasoning: string }>;
}

interface Props {
    trade: Trade;
    theme: 'dark' | 'light' | 'oled';
    /** Volá se s parciálním update, App.tsx pak uloží. */
    onUpdateTrade?: (updates: Partial<Trade>) => void;
}

const EDGE_BASE = (() => {
    const url = (supabase as any).supabaseUrl || (import.meta as any).env?.VITE_SUPABASE_URL;
    return url || '';
})();

/**
 * Expandable AI sekce v Trade Detail Modalu.
 * - Pokud má trade.data.aiSuggestions, zobrazí návrhy tagů s "Proč?" expandem.
 * - Pre-checked podle AI návrhu; uživatel může odznačit / přidat.
 * - "Použít" uloží do trade.* polí + zaloguje feedback do ai_suggestion_feedback.
 * - Pod tím chat panel pro diskuzi o obchodu (per-trade konverzace).
 */
const TradeAISection: React.FC<Props> = ({ trade, theme, onUpdateTrade }) => {
    const isDark = theme !== 'light';
    // Lokální kopie návrhů — chat může navrhnout změny, my je promítáme tady ihned
    const [suggestions, setSuggestions] = useState<AISuggestionsBlob | undefined>(trade.aiSuggestions as AISuggestionsBlob | undefined);

    // Sync s prop když se změní (např. po refresh trade objektu)
    useEffect(() => {
        setSuggestions(trade.aiSuggestions as AISuggestionsBlob | undefined);
    }, [trade.aiSuggestions]);

    const [expanded, setExpanded] = useState<boolean>(!!suggestions?.unreviewed);
    const [openReasoning, setOpenReasoning] = useState<Set<string>>(new Set());
    const [chatOpen, setChatOpen] = useState(false);

    // Pre-checked set podle aktuálních trade tagů (nebo AI návrhů pokud trade ještě nemá tagy)
    const initialChecked = (() => {
        const s = new Set<string>();
        // HTF
        for (const sug of suggestions?.htf || []) {
            if (trade.htfConfluence?.includes(sug.value) || !(trade.htfConfluence?.length)) s.add(`htf:${sug.value}`);
        }
        for (const sug of suggestions?.ltf || []) {
            if (trade.ltfConfluence?.includes(sug.value) || !(trade.ltfConfluence?.length)) s.add(`ltf:${sug.value}`);
        }
        for (const sug of suggestions?.mistakes || []) {
            if (trade.mistakes?.includes(sug.value) || !(trade.mistakes?.length)) s.add(`mistake:${sug.value}`);
        }
        for (const sug of suggestions?.emotions || []) {
            // Emotions trade stores by label match
            if (trade.emotions?.includes(sug.value) || !(trade.emotions?.length)) s.add(`emotion:${sug.value}`);
        }
        return s;
    })();

    const [checked, setChecked] = useState<Set<string>>(initialChecked);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    // ─── Chat ───────────────────────────────────────────────────────────────
    const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
    const [chatInput, setChatInput] = useState('');
    const [chatLoading, setChatLoading] = useState(false);
    const [conversationId, setConversationId] = useState<string | null>(null);
    const chatEndRef = useRef<HTMLDivElement>(null);

    // Load existing conversation pro tento trade
    useEffect(() => {
        if (!chatOpen) return;
        let cancelled = false;
        (async () => {
            const { data: convs } = await supabase
                .from('ai_conversations')
                .select('id')
                .eq('trade_id', trade.id)
                .order('created_at', { ascending: false })
                .limit(1);
            if (cancelled) return;
            const convId = convs?.[0]?.id || null;
            setConversationId(convId);
            if (convId) {
                const { data: msgs } = await supabase
                    .from('ai_messages')
                    .select('id, role, content, created_at, meta_data')
                    .eq('conversation_id', convId)
                    .order('created_at', { ascending: true });
                if (!cancelled && msgs) {
                    // Promítni meta_data.suggestionsUpdate do top-level pole (pro UI)
                    const enriched = msgs.map((m: any) => ({
                        ...m,
                        suggestionsUpdate: m.meta_data?.suggestionsUpdate || null,
                    }));
                    setChatMessages(enriched as ChatMessage[]);
                }
            } else {
                setChatMessages([]);
            }
        })();
        return () => { cancelled = true; };
    }, [chatOpen, trade.id]);

    useEffect(() => {
        if (chatEndRef.current) chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }, [chatMessages.length]);

    const toggleCheck = (key: string) => {
        setChecked(prev => {
            const n = new Set(prev);
            if (n.has(key)) n.delete(key);
            else n.add(key);
            return n;
        });
    };

    const toggleReasoning = (key: string) => {
        setOpenReasoning(prev => {
            const n = new Set(prev);
            if (n.has(key)) n.delete(key);
            else n.add(key);
            return n;
        });
    };

    // ─── Aplikuj návrhy do trade + zaloguj feedback ────────────────────────
    const applySelections = useCallback(async () => {
        if (!onUpdateTrade) return;
        setSaving(true);
        try {
            // Sestav nové pole tagů: existující + nové, mínus odznačené
            const buildField = (
                type: 'htf' | 'ltf' | 'mistake' | 'emotion',
                aiList: AISuggestion[] | undefined,
                currentList: string[] | undefined
            ): string[] => {
                const result = new Set<string>(currentList || []);
                const aiValues = (aiList || []).map(s => s.value);
                // AI hodnoty: pokud checked → přidej, pokud unchecked → odeber
                for (const v of aiValues) {
                    if (checked.has(`${type}:${v}`)) result.add(v);
                    else result.delete(v);
                }
                return Array.from(result);
            };

            const updates: Partial<Trade> = {
                htfConfluence: buildField('htf', suggestions?.htf, trade.htfConfluence),
                ltfConfluence: buildField('ltf', suggestions?.ltf, trade.ltfConfluence),
                mistakes: buildField('mistake', suggestions?.mistakes, trade.mistakes),
                emotions: buildField('emotion', suggestions?.emotions, trade.emotions),
                // Označ jako reviewed — storageService.updateTrade to mergne do data JSONB
                aiSuggestions: { ...suggestions, unreviewed: false } as any,
            };

            onUpdateTrade(updates);

            // Feedback log do ai_suggestion_feedback
            const { data: { user } } = await supabase.auth.getUser();
            if (user) {
                const feedbackRows: any[] = [];
                const pushFeedback = (
                    type: 'htf' | 'ltf' | 'mistake' | 'emotion',
                    list: AISuggestion[] | undefined,
                ) => {
                    for (const sug of list || []) {
                        const key = `${type}:${sug.value}`;
                        feedbackRows.push({
                            user_id: user.id,
                            trade_id: trade.id,
                            suggestion_type: type,
                            suggested_value: sug.value,
                            user_action: checked.has(key) ? 'accepted' : 'rejected',
                            ai_reasoning: sug.reasoning,
                        });
                    }
                };
                pushFeedback('htf', suggestions?.htf);
                pushFeedback('ltf', suggestions?.ltf);
                pushFeedback('mistake', suggestions?.mistakes);
                pushFeedback('emotion', suggestions?.emotions);

                if (feedbackRows.length > 0) {
                    await supabase.from('ai_suggestion_feedback').insert(feedbackRows);
                }
            }

            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
        } finally {
            setSaving(false);
        }
    }, [checked, suggestions, trade, onUpdateTrade]);

    // ─── Apply AI's proposed update na lokální suggestions ────────────────
    const applySuggestionsUpdate = useCallback((upd: SuggestionsUpdate, msgId: string) => {
        setSuggestions(prev => {
            const next: AISuggestionsBlob = JSON.parse(JSON.stringify(prev || {}));
            // Remove
            for (const r of upd.remove) {
                const key = r.type === 'mistake' ? 'mistakes' : r.type === 'emotion' ? 'emotions' : r.type;
                const arr = (next as any)[key] as AISuggestion[] | undefined;
                if (arr) (next as any)[key] = arr.filter(s => s.value !== r.value);
            }
            // Add (pokud už neexistuje)
            for (const a of upd.add) {
                const key = a.type === 'mistake' ? 'mistakes' : a.type === 'emotion' ? 'emotions' : a.type;
                const arr = ((next as any)[key] as AISuggestion[] | undefined) || [];
                if (!arr.find(s => s.value === a.value)) {
                    arr.push({ value: a.value, reasoning: a.reasoning });
                }
                (next as any)[key] = arr;
            }
            return next;
        });
        // Auto-check nově přidané
        setChecked(prev => {
            const n = new Set(prev);
            for (const r of upd.remove) n.delete(`${r.type}:${r.value}`);
            for (const a of upd.add) n.add(`${a.type}:${a.value}`);
            return n;
        });
        // Označ zprávu jako "applied" — vyhodíme suggestionsUpdate z ní
        setChatMessages(prev => prev.map(m => m.id === msgId ? { ...m, suggestionsUpdate: null } : m));
    }, []);

    const ignoreSuggestionsUpdate = useCallback((msgId: string) => {
        setChatMessages(prev => prev.map(m => m.id === msgId ? { ...m, suggestionsUpdate: null } : m));
    }, []);

    // ─── Chat send ─────────────────────────────────────────────────────────
    const sendChatMessage = useCallback(async () => {
        const text = chatInput.trim();
        if (!text || chatLoading) return;
        setChatLoading(true);
        const userMsg: ChatMessage = {
            id: `tmp-${Date.now()}`,
            role: 'user',
            content: text,
            created_at: new Date().toISOString(),
        };
        setChatMessages(prev => [...prev, userMsg]);
        setChatInput('');

        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) throw new Error('Not authenticated');

            const res = await fetch(`${EDGE_BASE}/functions/v1/chat-trade`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`,
                },
                body: JSON.stringify({
                    message: text,
                    conversationId,
                    tradeId: trade.id, // důležitý: backend pozná, že je to per-trade kontext
                }),
            });

            if (!res.ok) {
                const detail = await res.text().catch(() => '');
                throw new Error(`Chat failed: ${res.status} ${detail}`);
            }

            const data = await res.json();
            if (data.conversationId && !conversationId) setConversationId(data.conversationId);

            const assistantMsg: ChatMessage = {
                id: `ai-${Date.now()}`,
                role: 'assistant',
                content: data.reply || data.content || '(prázdná odpověď)',
                created_at: new Date().toISOString(),
                suggestionsUpdate: data.suggestionsUpdate || null,
            };
            setChatMessages(prev => [...prev, assistantMsg]);
        } catch (e: any) {
            setChatMessages(prev => [...prev, {
                id: `err-${Date.now()}`,
                role: 'assistant',
                content: `⚠️ Chyba: ${e?.message || 'unknown'}`,
                created_at: new Date().toISOString(),
            }]);
        } finally {
            setChatLoading(false);
        }
    }, [chatInput, chatLoading, conversationId, trade.id]);

    if (!suggestions) {
        return null; // Žádné AI návrhy → nic neukazuj
    }

    const totalSuggestions =
        (suggestions.htf?.length || 0) +
        (suggestions.ltf?.length || 0) +
        (suggestions.mistakes?.length || 0) +
        (suggestions.emotions?.length || 0);

    // Render jednoho návrhu
    const renderSuggestion = (
        type: 'htf' | 'ltf' | 'mistake' | 'emotion',
        sug: AISuggestion,
        colorClass: string,
    ) => {
        const key = `${type}:${sug.value}`;
        const isChecked = checked.has(key);
        const reasoningOpen = openReasoning.has(key);
        return (
            <div key={key} className={`rounded-xl border ${isDark ? 'border-white/10 bg-white/[0.02]' : 'border-slate-200 bg-white'} overflow-hidden`}>
                <div className="flex items-center justify-between px-3 py-2">
                    <label className="flex items-center gap-2 cursor-pointer flex-1 min-w-0">
                        <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggleCheck(key)}
                            className="w-4 h-4 rounded cursor-pointer accent-blue-500"
                        />
                        <span className={`text-xs font-black uppercase tracking-wide ${colorClass} truncate`}>{sug.value}</span>
                    </label>
                    <button
                        onClick={() => toggleReasoning(key)}
                        className={`text-[9px] font-black uppercase tracking-widest px-2 py-1 rounded-md transition-all flex items-center gap-1 ${isDark ? 'text-slate-400 hover:text-white hover:bg-white/5' : 'text-slate-500 hover:text-slate-900 hover:bg-slate-100'}`}
                    >
                        Proč? {reasoningOpen ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                    </button>
                </div>
                {reasoningOpen && (
                    <div className={`px-3 py-2 text-[11px] leading-relaxed border-t ${isDark ? 'border-white/5 bg-black/20 text-slate-300' : 'border-slate-100 bg-slate-50/50 text-slate-600'}`}>
                        {sug.reasoning || '(žádný reasoning)'}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className={`rounded-2xl border ${isDark ? 'border-blue-500/20 bg-blue-500/[0.03]' : 'border-blue-200 bg-blue-50/30'} overflow-hidden`}>
            {/* Header */}
            <button
                onClick={() => setExpanded(!expanded)}
                className="w-full flex items-center justify-between px-3 py-2 transition-all hover:bg-blue-500/5"
            >
                <div className="flex items-center gap-2">
                    <div className={`p-1.5 rounded-md bg-blue-500/10 border border-blue-500/20`}>
                        <Sparkles size={14} className="text-blue-500" />
                    </div>
                    <span className={`text-[10px] font-black uppercase tracking-[0.2em] ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                        AI Návrhy
                    </span>
                    {suggestions.unreviewed && (
                        <span className="px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-500 text-[8px] font-black uppercase tracking-widest">
                            Nezpracováno
                        </span>
                    )}
                    <span className={`text-[10px] font-bold ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>· {totalSuggestions} návrhů</span>
                </div>
                {expanded ? <ChevronUp size={14} className="text-slate-400" /> : <ChevronDown size={14} className="text-slate-400" />}
            </button>

            {expanded && (
                <div className="px-4 pb-4 space-y-3">
                    {/* Summary */}
                    {suggestions.summary && (
                        <div className={`p-3 rounded-xl text-[12px] leading-relaxed ${isDark ? 'bg-white/[0.03] text-slate-300' : 'bg-white/60 text-slate-700'} italic`}>
                            "{suggestions.summary}"
                        </div>
                    )}

                    {/* Suggestions per category */}
                    {suggestions.htf && suggestions.htf.length > 0 && (
                        <div>
                            <p className="text-[9px] font-black uppercase tracking-widest text-blue-500 mb-1.5">HTF Konfluence</p>
                            <div className="space-y-1.5">
                                {suggestions.htf.map(s => renderSuggestion('htf', s, 'text-blue-500'))}
                            </div>
                        </div>
                    )}
                    {suggestions.ltf && suggestions.ltf.length > 0 && (
                        <div>
                            <p className="text-[9px] font-black uppercase tracking-widest text-amber-500 mb-1.5">LTF Konfluence</p>
                            <div className="space-y-1.5">
                                {suggestions.ltf.map(s => renderSuggestion('ltf', s, 'text-amber-500'))}
                            </div>
                        </div>
                    )}
                    {suggestions.mistakes && suggestions.mistakes.length > 0 && (
                        <div>
                            <p className="text-[9px] font-black uppercase tracking-widest text-rose-500 mb-1.5">Chyby</p>
                            <div className="space-y-1.5">
                                {suggestions.mistakes.map(s => renderSuggestion('mistake', s, 'text-rose-500'))}
                            </div>
                        </div>
                    )}
                    {suggestions.emotions && suggestions.emotions.length > 0 && (
                        <div>
                            <p className="text-[9px] font-black uppercase tracking-widest text-purple-500 mb-1.5">Emoce</p>
                            <div className="space-y-1.5">
                                {suggestions.emotions.map(s => renderSuggestion('emotion', s, 'text-purple-500'))}
                            </div>
                        </div>
                    )}

                    {/* Action buttons */}
                    <div className="flex items-center gap-2 pt-2">
                        <button
                            onClick={applySelections}
                            disabled={saving || !onUpdateTrade}
                            className={`flex-1 px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-1.5 ${
                                saved
                                    ? 'bg-emerald-500 text-white'
                                    : 'bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed'
                            }`}
                        >
                            {saving ? <Loader2 size={12} className="animate-spin" /> : saved ? <Check size={12} /> : <Check size={12} />}
                            {saved ? 'Uloženo' : saving ? 'Ukládám…' : 'Použít vybrané'}
                        </button>
                        <button
                            onClick={() => setChatOpen(!chatOpen)}
                            className={`px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-1.5 ${
                                chatOpen
                                    ? 'bg-purple-600 text-white'
                                    : isDark
                                        ? 'bg-white/5 text-slate-300 hover:bg-white/10'
                                        : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                            }`}
                        >
                            <MessageCircle size={12} />
                            {chatOpen ? 'Zavřít chat' : 'Zeptat se'}
                        </button>
                    </div>

                    {/* Per-trade chat */}
                    {chatOpen && (
                        <div className={`rounded-xl border ${isDark ? 'border-white/10 bg-black/30' : 'border-slate-200 bg-white'} overflow-hidden mt-2`}>
                            <div className="px-3 py-2 border-b border-white/5 flex items-center gap-2">
                                <MessageCircle size={11} className="text-purple-500" />
                                <span className="text-[9px] font-black uppercase tracking-widest text-purple-500">Diskuze o obchodu</span>
                            </div>
                            <div className="max-h-[280px] overflow-y-auto p-3 space-y-2">
                                {chatMessages.length === 0 && !chatLoading && (
                                    <p className={`text-[11px] text-center py-4 ${isDark ? 'text-slate-500' : 'text-slate-400'} italic`}>
                                        Zeptej se proč navrhuju tyhle tagy, nebo na cokoliv o tomhle obchodu.
                                    </p>
                                )}
                                {chatMessages.map(msg => (
                                    <div key={msg.id}>
                                        <div className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                            <div className={`max-w-[85%] px-3 py-2 rounded-2xl text-[12px] leading-relaxed whitespace-pre-wrap ${
                                                msg.role === 'user'
                                                    ? 'bg-blue-600 text-white rounded-tr-sm'
                                                    : isDark
                                                        ? 'bg-white/5 text-slate-200 rounded-tl-sm'
                                                        : 'bg-slate-100 text-slate-800 rounded-tl-sm'
                                            }`}>
                                                {msg.content}
                                            </div>
                                        </div>
                                        {/* AI navrhuje úpravu tagů — banner s accept/ignore */}
                                        {msg.role === 'assistant' && msg.suggestionsUpdate && (msg.suggestionsUpdate.add.length > 0 || msg.suggestionsUpdate.remove.length > 0) && (
                                            <div className={`mt-1.5 ml-2 rounded-xl border-2 border-dashed ${isDark ? 'border-amber-500/40 bg-amber-500/[0.05]' : 'border-amber-400 bg-amber-50'} p-2.5`}>
                                                <p className="text-[9px] font-black uppercase tracking-widest text-amber-500 mb-1.5 flex items-center gap-1">
                                                    <Sparkles size={10} /> AI navrhuje úpravu tagů
                                                </p>
                                                {msg.suggestionsUpdate.remove.length > 0 && (
                                                    <p className={`text-[11px] mb-1 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                                                        <span className="text-rose-500 font-black">Odebrat:</span>{' '}
                                                        {msg.suggestionsUpdate.remove.map(r => `${r.type.toUpperCase()} "${r.value}"`).join(', ')}
                                                    </p>
                                                )}
                                                {msg.suggestionsUpdate.add.length > 0 && (
                                                    <p className={`text-[11px] mb-2 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                                                        <span className="text-emerald-500 font-black">Přidat:</span>{' '}
                                                        {msg.suggestionsUpdate.add.map(a => `${a.type.toUpperCase()} "${a.value}"`).join(', ')}
                                                    </p>
                                                )}
                                                <div className="flex gap-1.5">
                                                    <button
                                                        onClick={() => applySuggestionsUpdate(msg.suggestionsUpdate!, msg.id)}
                                                        className="px-2.5 py-1 rounded-lg bg-amber-500 hover:bg-amber-400 text-white text-[9px] font-black uppercase tracking-widest transition-all"
                                                    >
                                                        ✓ Přijmout
                                                    </button>
                                                    <button
                                                        onClick={() => ignoreSuggestionsUpdate(msg.id)}
                                                        className={`px-2.5 py-1 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all ${isDark ? 'bg-white/5 text-slate-400 hover:bg-white/10' : 'bg-slate-200 text-slate-500 hover:bg-slate-300'}`}
                                                    >
                                                        Ignorovat
                                                    </button>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                ))}
                                {chatLoading && (
                                    <div className="flex justify-start">
                                        <div className={`px-3 py-2 rounded-2xl ${isDark ? 'bg-white/5' : 'bg-slate-100'}`}>
                                            <Loader2 size={12} className="animate-spin text-purple-500" />
                                        </div>
                                    </div>
                                )}
                                <div ref={chatEndRef} />
                            </div>
                            <div className={`p-2 border-t flex items-center gap-2 ${isDark ? 'border-white/5' : 'border-slate-200'}`}>
                                <input
                                    type="text"
                                    value={chatInput}
                                    onChange={e => setChatInput(e.target.value)}
                                    onKeyDown={e => { if (e.key === 'Enter') sendChatMessage(); }}
                                    placeholder="Zeptej se…"
                                    disabled={chatLoading}
                                    className={`flex-1 px-3 py-2 rounded-xl text-xs outline-none ${
                                        isDark
                                            ? 'bg-white/5 text-slate-200 placeholder-slate-500 border border-white/10 focus:border-purple-500'
                                            : 'bg-slate-50 text-slate-800 placeholder-slate-400 border border-slate-200 focus:border-purple-500'
                                    }`}
                                />
                                <button
                                    onClick={sendChatMessage}
                                    disabled={!chatInput.trim() || chatLoading}
                                    className="p-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-30 transition-all"
                                >
                                    <Send size={14} />
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default TradeAISection;
