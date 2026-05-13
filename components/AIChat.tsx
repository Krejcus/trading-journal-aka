import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Bot, X, Send, Loader2, ChevronDown, Sparkles, TrendingUp, TrendingDown, Calendar } from 'lucide-react';
import type { Trade, Account, IronRule, PlaybookItem, DailyPrep, DailyReview } from '../types';
import { streamAIResponse, buildTraderContext, stripTradeRefs, type AIMessage } from '../services/aiService';

interface Props {
  trades: Trade[];
  accounts: Account[];
  ironRules: IronRule[];
  playbookItems: PlaybookItem[];
  dailyPreps: DailyPrep[];
  dailyReviews: DailyReview[];
  theme?: string;
  onOpenTrade?: (trade: Trade) => void;
}

// Mini trade karta zobrazená v chatu
const TradeMiniCard: React.FC<{ trade: Trade; onClick?: () => void }> = ({ trade, onClick }) => {
  const isWin = trade.pnl > 0;
  return (
    <div
      onClick={onClick}
      className={`flex items-center gap-3 p-3 rounded-2xl border cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98] ${
        isWin
          ? 'bg-emerald-500/5 border-emerald-500/20 hover:border-emerald-500/40'
          : 'bg-rose-500/5 border-rose-500/20 hover:border-rose-500/40'
      }`}
    >
      {/* Screenshot thumbnail */}
      {trade.screenshot ? (
        <div className="w-14 h-10 rounded-lg overflow-hidden flex-shrink-0 border border-white/10">
          <img src={trade.screenshot} alt="" className="w-full h-full object-cover" />
        </div>
      ) : (
        <div className="w-14 h-10 rounded-lg flex-shrink-0 bg-white/5 border border-white/10 flex items-center justify-center">
          {isWin ? <TrendingUp size={14} className="text-emerald-500" /> : <TrendingDown size={14} className="text-rose-500" />}
        </div>
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">{trade.instrument}</span>
          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${isWin ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'}`}>
            {trade.direction}
          </span>
        </div>
        <div className={`text-sm font-black font-mono ${isWin ? 'text-emerald-500' : 'text-rose-500'}`}>
          {isWin ? '+' : ''}${trade.pnl.toFixed(0)}
        </div>
        {trade.mistakes?.[0] && (
          <div className="text-[9px] text-amber-500/80 truncate mt-0.5">⚠ {trade.mistakes?.[0]}</div>
        )}
      </div>

      <div className="flex flex-col items-end gap-1 flex-shrink-0">
        <div className="flex items-center gap-1 text-slate-500">
          <Calendar size={9} />
          <span className="text-[9px] font-mono">{trade.date?.slice(0, 10)}</span>
        </div>
        {trade.signal && (
          <span className="text-[8px] text-slate-500 bg-white/5 px-1.5 py-0.5 rounded border border-white/10 truncate max-w-[80px]">
            {trade.signal}
          </span>
        )}
      </div>
    </div>
  );
};

// Bublina zprávy
const MessageBubble: React.FC<{
  msg: AIMessage & { tradeCards?: Trade[] };
  onOpenTrade?: (trade: Trade) => void;
}> = ({ msg, onOpenTrade }) => {
  const isUser = msg.role === 'user';

  return (
    <div className={`flex gap-2 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      {!isUser && (
        <div className="w-7 h-7 rounded-full bg-blue-600/20 border border-blue-500/30 flex items-center justify-center flex-shrink-0 mt-1">
          <Sparkles size={13} className="text-blue-400" />
        </div>
      )}
      <div className={`max-w-[85%] space-y-2 ${isUser ? 'items-end' : 'items-start'} flex flex-col`}>
        <div className={`px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
          isUser
            ? 'bg-blue-600 text-white rounded-tr-sm'
            : 'bg-white/[0.06] border border-white/10 text-slate-200 rounded-tl-sm'
        }`}>
          {(msg.role === 'assistant' ? stripTradeRefs(msg.content) : msg.content) || (
            <span className="flex items-center gap-2 text-slate-400">
              <Loader2 size={13} className="animate-spin" />
              <span className="text-xs">Přemýšlím...</span>
            </span>
          )}
        </div>

        {/* Trade karty pokud AI zavolalo show_trades */}
        {msg.tradeCards && msg.tradeCards.length > 0 && (
          <div className="w-full space-y-2 mt-1">
            {msg.tradeCards.map(trade => (
              <TradeMiniCard
                key={trade.id}
                trade={trade}
                onClick={() => onOpenTrade?.(trade)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// Návrhy rychlých otázek
const QUICK_PROMPTS = [
  'Jaké jsou moje nejčastější chyby?',
  'Ukaž mi 3 nejhorší obchody',
  'Jak mi jde tento týden?',
  'Kde ztrácím nejvíc peněz?',
  'Jaký setup mi funguje nejlépe?',
];

// ─── Hlavní komponenta ────────────────────────────────────────────────────────

const AIChat: React.FC<Props> = ({
  trades, accounts, ironRules, playbookItems,
  dailyPreps, dailyReviews, theme, onOpenTrade,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<(AIMessage & { tradeCards?: Trade[] })[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isDark = theme !== 'light';

  // Sestavení kontextu (memoized — přepočítá se jen když se data změní)
  const traderContext = React.useMemo(() =>
    buildTraderContext({ trades, accounts, ironRules, playbookItems, dailyPreps, dailyReviews }),
    [trades, accounts, ironRules, playbookItems, dailyPreps, dailyReviews]
  );

  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen, messages.length]);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || isStreaming) return;
    setError(null);

    const userMsg: AIMessage = { role: 'user', content: text.trim() };
    const assistantMsg: AIMessage & { tradeCards?: Trade[] } = { role: 'assistant', content: '' };

    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setInput('');
    setIsStreaming(true);

    // Historie pro API (bez tradeCards — jen text)
    const history: AIMessage[] = [...messages, userMsg].map(m => ({
      role: m.role,
      content: m.content,
    }));

    await streamAIResponse(
      history,
      traderContext,
      trades,
      // onChunk — přidá text do poslední zprávy
      (chunk) => {
        setMessages(prev => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last.role === 'assistant') {
            updated[updated.length - 1] = { ...last, content: last.content + chunk };
          }
          return updated;
        });
      },
      // onTradeRefs — najde obchody a přidá karty
      (ids) => {
        const foundTrades = ids
          .map(id => trades.find(t => String(t.id) === id))
          .filter(Boolean) as Trade[];
        if (foundTrades.length > 0) {
          setMessages(prev => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last.role === 'assistant') {
              updated[updated.length - 1] = {
                ...last,
                tradeCards: [...(last.tradeCards || []), ...foundTrades],
              };
            }
            return updated;
          });
        }
      },
      // onDone
      () => setIsStreaming(false),
      // onError
      (err) => {
        setError(err);
        setIsStreaming(false);
        setMessages(prev => prev.slice(0, -1)); // odstraní prázdnou assistant zprávu
      },
    );
  }, [messages, traderContext, trades, isStreaming]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  return (
    <>
      {/* Floating button */}
      <button
        onClick={() => setIsOpen(o => !o)}
        className={`fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full bg-blue-600 hover:bg-blue-500 text-white shadow-2xl shadow-blue-500/30 flex items-center justify-center transition-all duration-300 hover:scale-110 active:scale-95 ${
          isOpen ? 'rotate-0' : ''
        }`}
        title="AI Coach"
      >
        {isOpen
          ? <ChevronDown size={22} />
          : <Bot size={22} />
        }
      </button>

      {/* Chat panel */}
      {isOpen && (
        <div className={`fixed bottom-24 right-6 z-50 w-[380px] max-w-[calc(100vw-24px)] h-[600px] max-h-[calc(100vh-120px)] flex flex-col rounded-3xl border shadow-2xl shadow-black/40 overflow-hidden transition-all duration-300 animate-in slide-in-from-bottom-4 fade-in ${
          isDark
            ? 'bg-[#0d0d12] border-white/10'
            : 'bg-white border-slate-200'
        }`}>

          {/* Header */}
          <div className={`flex items-center gap-3 px-5 py-4 border-b flex-shrink-0 ${isDark ? 'border-white/10' : 'border-slate-100'}`}>
            <div className="w-9 h-9 rounded-xl bg-blue-600/15 border border-blue-500/25 flex items-center justify-center">
              <Sparkles size={16} className="text-blue-400" />
            </div>
            <div>
              <h3 className="text-sm font-black uppercase tracking-widest text-white">AI Coach</h3>
              <p className="text-[10px] text-slate-500 font-mono">{trades.length} obchodů v kontextu</p>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="ml-auto p-2 rounded-xl hover:bg-white/5 text-slate-500 hover:text-slate-300 transition-all"
            >
              <X size={16} />
            </button>
          </div>

          {/* Zprávy */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 scrollbar-thin">
            {messages.length === 0 && (
              <div className="space-y-4">
                <div className="text-center pt-4">
                  <div className="w-12 h-12 rounded-2xl bg-blue-600/10 border border-blue-500/20 flex items-center justify-center mx-auto mb-3">
                    <Bot size={22} className="text-blue-400" />
                  </div>
                  <p className="text-sm font-black text-white">Ahoj! Jsem tvůj AI Coach.</p>
                  <p className="text-xs text-slate-500 mt-1">Zeptej se mě na cokoliv z tvého obchodování.</p>
                </div>

                {/* Quick prompts */}
                <div className="space-y-2">
                  {QUICK_PROMPTS.map(q => (
                    <button
                      key={q}
                      onClick={() => sendMessage(q)}
                      className="w-full text-left px-4 py-2.5 rounded-xl border border-white/8 bg-white/[0.03] hover:bg-white/[0.07] text-xs text-slate-300 hover:text-white transition-all"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg, i) => (
              <MessageBubble
                key={i}
                msg={msg}
                onOpenTrade={onOpenTrade}
              />
            ))}

            {error && (
              <div className="px-4 py-3 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-xs text-rose-400">
                ⚠ {error}
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className={`px-4 py-3 border-t flex-shrink-0 ${isDark ? 'border-white/10' : 'border-slate-100'}`}>
            <div className={`flex items-end gap-2 rounded-2xl border px-4 py-3 ${
              isDark ? 'bg-white/[0.04] border-white/10' : 'bg-slate-50 border-slate-200'
            }`}>
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Napiš zprávu... (Enter = odeslat)"
                rows={1}
                disabled={isStreaming}
                className="flex-1 bg-transparent text-sm text-white placeholder-slate-500 resize-none outline-none max-h-32 scrollbar-thin disabled:opacity-50"
                style={{ lineHeight: '1.5' }}
              />
              <button
                onClick={() => sendMessage(input)}
                disabled={!input.trim() || isStreaming}
                className="w-8 h-8 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center flex-shrink-0 transition-all active:scale-95"
              >
                {isStreaming
                  ? <Loader2 size={14} className="text-white animate-spin" />
                  : <Send size={14} className="text-white" />
                }
              </button>
            </div>
            <p className="text-[9px] text-slate-600 text-center mt-2">Shift+Enter = nový řádek</p>
          </div>
        </div>
      )}
    </>
  );
};

export default AIChat;
