import React, { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  X, ZoomIn, ChevronLeft, ChevronRight, TrendingUp, TrendingDown,
  Calendar, ExternalLink, Moon, Sun, CheckCircle2, XCircle, Target,
  Brain, Star, Loader2, Sparkles,
} from 'lucide-react';
import type { Trade, DailyPrep, DailyReview } from '../types';
import { stripAllRefs, type AIMessage, type ChartSpec } from '../services/aiService';
import { DynamicChart } from './AICharts';

// ─── Extended message type ────────────────────────────────────────────────────

export type ExtendedMessage = AIMessage & {
  tradeCards?: Trade[];
  prepCards?: DailyPrep[];
  reviewCards?: DailyReview[];
  chartSpecs?: ChartSpec[];
};

// ─── Lightbox ─────────────────────────────────────────────────────────────────

export const ScreenshotLightbox: React.FC<{
  images: string[];
  startIndex: number;
  onClose: () => void;
}> = ({ images, startIndex, onClose }) => {
  const [idx, setIdx] = useState(startIndex);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setIdx(i => Math.min(i + 1, images.length - 1));
      if (e.key === 'ArrowLeft') setIdx(i => Math.max(i - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [images.length, onClose]);

  return (
    <div className="fixed inset-0 z-[200] bg-black/90 flex items-center justify-center" onClick={onClose}>
      <button onClick={onClose} className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white">
        <X size={20} />
      </button>
      {images.length > 1 && (
        <>
          <button
            onClick={e => { e.stopPropagation(); setIdx(i => Math.max(i - 1, 0)); }}
            className="absolute left-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white disabled:opacity-30"
            disabled={idx === 0}
          >
            <ChevronLeft size={20} />
          </button>
          <button
            onClick={e => { e.stopPropagation(); setIdx(i => Math.min(i + 1, images.length - 1)); }}
            className="absolute right-14 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white disabled:opacity-30"
            disabled={idx === images.length - 1}
          >
            <ChevronRight size={20} />
          </button>
          <div className="absolute bottom-4 text-white/50 text-xs">{idx + 1} / {images.length}</div>
        </>
      )}
      <img
        src={images[idx]}
        alt=""
        className="max-w-[95vw] max-h-[90vh] object-contain rounded-xl"
        onClick={e => e.stopPropagation()}
      />
    </div>
  );
};

// ─── Trade karta ─────────────────────────────────────────────────────────────

export const TradeMiniCard: React.FC<{ trade: Trade; onClick?: () => void }> = ({ trade, onClick }) => {
  const isWin = trade.pnl > 0;
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const images = [
    ...(trade.screenshot ? [trade.screenshot] : []),
    ...(trade.screenshots?.filter(s => s && s !== trade.screenshot) ?? []),
  ];

  return (
    <>
      <div className={`group rounded-2xl border overflow-hidden transition-all hover:scale-[1.01] ${
        isWin
          ? 'bg-emerald-500/5 border-emerald-500/20 hover:border-emerald-500/40'
          : 'bg-rose-500/5 border-rose-500/20 hover:border-rose-500/40'
      }`}>
        {images.length > 0 ? (
          <div className="relative w-full h-36 overflow-hidden cursor-zoom-in" onClick={() => setLightboxOpen(true)}>
            <img src={images[0]} alt="" className="w-full h-full object-cover" />
            <div className="absolute inset-0 bg-black/0 hover:bg-black/20 transition-all flex items-center justify-center opacity-0 hover:opacity-100">
              <div className="bg-black/60 rounded-full p-2"><ZoomIn size={16} className="text-white" /></div>
            </div>
            {images.length > 1 && (
              <div className="absolute top-2 right-2 bg-black/60 text-white text-[9px] px-1.5 py-0.5 rounded-full">+{images.length - 1}</div>
            )}
          </div>
        ) : (
          <div className="w-full h-14 bg-[var(--bg-card)] flex items-center justify-center border-b border-[var(--border-subtle)]">
            {isWin
              ? <TrendingUp size={18} className="text-emerald-500/30" />
              : <TrendingDown size={18} className="text-rose-500/30" />
            }
          </div>
        )}

        <div onClick={onClick} className="flex items-center gap-3 p-3 cursor-pointer">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-[10px] font-black uppercase tracking-widest text-[var(--text-secondary)]">{trade.instrument}</span>
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${isWin ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'}`}>{trade.direction}</span>
              {trade.signal && <span className="text-[8px] text-[var(--text-secondary)] bg-[var(--bg-card)] px-1.5 py-0.5 rounded border border-[var(--border-subtle)] truncate max-w-[70px]">{trade.signal}</span>}
            </div>
            <div className={`text-sm font-black font-mono ${isWin ? 'text-emerald-500' : 'text-rose-500'}`}>
              {isWin ? '+' : ''}${trade.pnl.toFixed(0)}
            </div>
            {trade.mistakes?.[0] && <div className="text-[9px] text-amber-500/80 truncate mt-0.5">⚠ {trade.mistakes[0]}</div>}
          </div>
          <div className="flex flex-col items-end gap-1 flex-shrink-0">
            <div className="flex items-center gap-1 text-[var(--text-secondary)]">
              <Calendar size={9} /><span className="text-[9px] font-mono">{trade.date?.slice(0, 10)}</span>
            </div>
            <div className="flex items-center gap-0.5 text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] transition-colors">
              <ExternalLink size={8} /><span className="text-[8px]">detail</span>
            </div>
          </div>
        </div>
      </div>
      {lightboxOpen && images.length > 0 && (
        <ScreenshotLightbox images={images} startIndex={0} onClose={() => setLightboxOpen(false)} />
      )}
    </>
  );
};

// ─── Prep karta ──────────────────────────────────────────────────────────────

export const PrepMiniCard: React.FC<{ prep: DailyPrep; onOpen?: () => void }> = ({ prep, onOpen }) => {
  const [lightbox, setLightbox] = useState<{ images: string[]; idx: number } | null>(null);

  const biasColor = prep.bias?.toLowerCase().includes('bull')
    ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
    : prep.bias?.toLowerCase().includes('bear')
    ? 'text-rose-400 bg-rose-500/10 border-rose-500/20'
    : 'text-[var(--text-secondary)] bg-[var(--bg-card)] border-[var(--border-subtle)]';

  const checks = prep.checklist;
  const checkItems = checks ? [
    { label: 'Spánek', ok: checks.sleptWell },
    { label: 'Plán', ok: checks.planReady },
    { label: 'Disciplína', ok: checks.disciplineCommitted },
    { label: 'Zprávy', ok: checks.newsChecked },
  ] : [];

  const images: string[] = [
    ...(prep.scenarios?.scenarioImages ?? []),
    ...(prep.scenarios?.bullishImage ? [prep.scenarios.bullishImage] : []),
    ...(prep.scenarios?.bearishImage ? [prep.scenarios.bearishImage] : []),
    ...(prep.scenarios?.sessions?.flatMap(s => s.image ? [s.image] : []) ?? []),
  ].filter(Boolean);

  return (
    <>
      <div className="rounded-2xl border border-indigo-500/20 bg-indigo-500/5 overflow-hidden">
        {images.length > 0 && (
          <div
            className="relative w-full overflow-hidden cursor-zoom-in border-b border-[var(--border-subtle)]"
            style={{ height: images.length === 1 ? '140px' : '100px' }}
            onClick={() => setLightbox({ images, idx: 0 })}
          >
            {images.length === 1 ? (
              <>
                <img src={images[0]} alt="" className="w-full h-full object-cover" />
                <div className="absolute inset-0 bg-black/0 hover:bg-black/20 transition-all flex items-center justify-center opacity-0 hover:opacity-100">
                  <div className="bg-black/60 rounded-full p-2"><ZoomIn size={14} className="text-white" /></div>
                </div>
              </>
            ) : (
              <div className="flex gap-1 p-1 h-full">
                {images.slice(0, 3).map((img, i) => (
                  <div
                    key={i}
                    className="relative flex-1 rounded-lg overflow-hidden"
                    onClick={e => { e.stopPropagation(); setLightbox({ images, idx: i }); }}
                  >
                    <img src={img} alt="" className="w-full h-full object-cover hover:scale-105 transition-transform" />
                    {i === 2 && images.length > 3 && (
                      <div className="absolute inset-0 bg-black/60 flex items-center justify-center text-white text-xs font-bold">+{images.length - 3}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div
          onClick={onOpen}
          className={`group flex items-center justify-between px-3 pt-3 pb-2 border-b border-[var(--border-subtle)] ${onOpen ? 'cursor-pointer hover:bg-[var(--bg-card)] transition-colors' : ''}`}
        >
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-indigo-500/10"><Sun size={11} className="text-indigo-400" /></div>
            <div>
              <div className="text-[9px] font-black uppercase tracking-widest text-indigo-400">Příprava</div>
              <div className="text-[11px] font-bold text-[var(--text-primary)]">{prep.date}</div>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {prep.bias && (
              <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full border ${biasColor}`}>{prep.bias}</span>
            )}
            {prep.confidence != null && (
              <span className="text-[9px] font-mono text-[var(--text-secondary)]">{prep.confidence}%</span>
            )}
            {onOpen && (
              <div className="flex items-center gap-0.5 text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] transition-colors">
                <ExternalLink size={8} /><span className="text-[8px]">otevřít</span>
              </div>
            )}
          </div>
        </div>

        <div className="px-3 py-2 space-y-2">
          {prep.confidence != null && (
            <div className="w-full h-1 rounded-full bg-[var(--bg-card)] overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-blue-400 transition-all"
                style={{ width: `${prep.confidence}%` }}
              />
            </div>
          )}

          {prep.mindsetState && (
            <div className="flex items-start gap-1.5">
              <Brain size={9} className="text-[var(--text-secondary)] mt-0.5 flex-shrink-0" />
              <span className="text-[10px] text-[var(--text-primary)] leading-relaxed">{prep.mindsetState}</span>
            </div>
          )}

          {checkItems.length > 0 && (
            <div className="flex gap-2 flex-wrap">
              {checkItems.map(c => (
                <div key={c.label} className={`flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-md ${c.ok ? 'text-emerald-400 bg-emerald-500/10' : 'text-[var(--text-secondary)] bg-[var(--bg-card)]'}`}>
                  {c.ok ? <CheckCircle2 size={8} /> : <XCircle size={8} />}
                  {c.label}
                </div>
              ))}
            </div>
          )}

          {prep.goals?.length > 0 && (
            <div className="space-y-0.5">
              {prep.goals.slice(0, 3).map((g, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  <Target size={8} className="text-indigo-400 mt-0.5 flex-shrink-0" />
                  <span className="text-[10px] text-[var(--text-primary)] leading-relaxed">{g}</span>
                </div>
              ))}
              {prep.goals.length > 3 && <span className="text-[9px] text-[var(--text-secondary)]">+{prep.goals.length - 3} dalších cílů</span>}
            </div>
          )}

          {images.length === 0 && (prep.scenarios?.bullish || prep.scenarios?.bearish) && (
            <div className="grid grid-cols-2 gap-1.5 mt-1">
              {prep.scenarios.bullish && (
                <div className="p-1.5 rounded-lg bg-emerald-500/5 border border-emerald-500/10">
                  <div className="text-[8px] font-black text-emerald-500/60 uppercase mb-0.5">Bullish</div>
                  <div className="text-[9px] text-[var(--text-secondary)] line-clamp-2">{prep.scenarios.bullish}</div>
                </div>
              )}
              {prep.scenarios.bearish && (
                <div className="p-1.5 rounded-lg bg-rose-500/5 border border-rose-500/10">
                  <div className="text-[8px] font-black text-rose-500/60 uppercase mb-0.5">Bearish</div>
                  <div className="text-[9px] text-[var(--text-secondary)] line-clamp-2">{prep.scenarios.bearish}</div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {lightbox && (
        <ScreenshotLightbox images={lightbox.images} startIndex={lightbox.idx} onClose={() => setLightbox(null)} />
      )}
    </>
  );
};

// ─── Review karta ─────────────────────────────────────────────────────────────

export const ReviewMiniCard: React.FC<{ review: DailyReview; onOpen?: () => void }> = ({ review, onOpen }) => {
  const [lightbox, setLightbox] = useState<{ images: string[]; idx: number } | null>(null);

  const scenarioColor = review.scenarioResult === 'Bullish'
    ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
    : review.scenarioResult === 'Bearish'
    ? 'text-rose-400 bg-rose-500/10 border-rose-500/20'
    : review.scenarioResult === 'Range'
    ? 'text-amber-400 bg-amber-500/10 border-amber-500/20'
    : 'text-[var(--text-secondary)] bg-[var(--bg-card)] border-[var(--border-subtle)]';

  const stars = review.rating ?? 0;

  const images: string[] = (review.sessionBreakdowns ?? [])
    .map(s => s.screenshot)
    .filter(Boolean) as string[];

  return (
    <>
      <div className="rounded-2xl border border-violet-500/20 bg-violet-500/5 overflow-hidden">
        {images.length > 0 && (
          <div
            className="relative w-full overflow-hidden cursor-zoom-in border-b border-[var(--border-subtle)]"
            style={{ height: images.length === 1 ? '140px' : '100px' }}
            onClick={() => setLightbox({ images, idx: 0 })}
          >
            {images.length === 1 ? (
              <>
                <img src={images[0]} alt="" className="w-full h-full object-cover" />
                <div className="absolute inset-0 bg-black/0 hover:bg-black/20 transition-all flex items-center justify-center opacity-0 hover:opacity-100">
                  <div className="bg-black/60 rounded-full p-2"><ZoomIn size={14} className="text-white" /></div>
                </div>
              </>
            ) : (
              <div className="flex gap-1 p-1 h-full">
                {images.slice(0, 3).map((img, i) => (
                  <div
                    key={i}
                    className="relative flex-1 rounded-lg overflow-hidden"
                    onClick={e => { e.stopPropagation(); setLightbox({ images, idx: i }); }}
                  >
                    <img src={img} alt="" className="w-full h-full object-cover hover:scale-105 transition-transform" />
                    {i === 2 && images.length > 3 && (
                      <div className="absolute inset-0 bg-black/60 flex items-center justify-center text-white text-xs font-bold">+{images.length - 3}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div
          onClick={onOpen}
          className={`group flex items-center justify-between px-3 pt-3 pb-2 border-b border-[var(--border-subtle)] ${onOpen ? 'cursor-pointer hover:bg-[var(--bg-card)] transition-colors' : ''}`}
        >
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-violet-500/10"><Moon size={11} className="text-violet-400" /></div>
            <div>
              <div className="text-[9px] font-black uppercase tracking-widest text-violet-400">Audit</div>
              <div className="text-[11px] font-bold text-[var(--text-primary)]">{review.date}</div>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {review.scenarioResult && (
              <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full border ${scenarioColor}`}>{review.scenarioResult}</span>
            )}
            <div className="flex gap-0.5">
              {[1, 2, 3, 4, 5].map(s => (
                <Star key={s} size={9} className={s <= stars ? 'text-amber-400 fill-amber-400' : 'text-slate-700 fill-slate-700'} />
              ))}
            </div>
            {onOpen && (
              <div className="flex items-center gap-0.5 text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] transition-colors">
                <ExternalLink size={8} /><span className="text-[8px]">otevřít</span>
              </div>
            )}
          </div>
        </div>

        <div className="px-3 py-2 space-y-2">
          {review.mainTakeaway && (
            <div className="p-2 rounded-lg bg-[var(--bg-card)] border border-[var(--border-subtle)]">
              <div className="text-[8px] font-black uppercase text-[var(--text-secondary)] mb-0.5">Hlavní poznatek</div>
              <div className="text-[10px] text-[var(--text-primary)] leading-relaxed">{review.mainTakeaway}</div>
            </div>
          )}

          {review.mistakes?.length > 0 && (
            <div className="space-y-0.5">
              {review.mistakes.slice(0, 3).map((m, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  <span className="text-amber-500 text-[9px] flex-shrink-0 mt-0.5">⚠</span>
                  <span className="text-[10px] text-[var(--text-primary)]">{m}</span>
                </div>
              ))}
              {review.mistakes.length > 3 && <span className="text-[9px] text-[var(--text-secondary)] pl-4">+{review.mistakes.length - 3} dalších</span>}
            </div>
          )}

          {review.goalResults?.length > 0 && (
            <div className="grid grid-cols-1 gap-0.5">
              {review.goalResults.slice(0, 4).map((g, i) => (
                <div key={i} className={`flex items-center gap-1.5 text-[9px] ${g.achieved ? 'text-emerald-400' : 'text-[var(--text-secondary)]'}`}>
                  {g.achieved ? <CheckCircle2 size={8} className="flex-shrink-0" /> : <XCircle size={8} className="flex-shrink-0" />}
                  <span className="truncate">{g.text}</span>
                </div>
              ))}
            </div>
          )}

          {review.lessons && (
            <div className="text-[9px] text-[var(--text-secondary)] italic border-l-2 border-violet-500/30 pl-2">{review.lessons}</div>
          )}

          {review.psycho?.notes && (
            <div className="flex items-start gap-1.5">
              <Brain size={9} className="text-[var(--text-secondary)] mt-0.5 flex-shrink-0" />
              <span className="text-[9px] text-[var(--text-secondary)]">{review.psycho.notes}</span>
            </div>
          )}
        </div>
      </div>

      {lightbox && (
        <ScreenshotLightbox images={lightbox.images} startIndex={lightbox.idx} onClose={() => setLightbox(null)} />
      )}
    </>
  );
};

// ─── Message bubble ───────────────────────────────────────────────────────────

// ─── Typewriter hook ──────────────────────────────────────────────────────────
//
// Technika: přímé DOM zápisy (žádný React setState/re-render během animace).
// Time-based rychlost: počet znaků je řízen uplynulým časem, ne počtem framů.
// → pokud React zablokuje main thread na 1–2 snímky, animace naváže plynule
//   místo aby "sekla" (frame-based to nedokáže).

const CHARS_PER_SEC = 75; // znaků za sekundu — klidné, čitelné tempo

function useTypewriter(fullContent: string, active: boolean) {
  const isPreloaded = !active && fullContent !== '';
  const [done, setDone] = useState(isPreloaded);

  const animRef = useRef<HTMLSpanElement>(null);

  const r = useRef({
    queue: '',
    text: '',
    raf: 0,
    active,
    done: isPreloaded,
    startTime: 0,       // timestamp kdy jsme začali psát (pro time-based výpočet)
    charsShown: 0,      // kolik znaků bylo zobrazeno v momentě startTime
  });
  r.current.active = active;

  // Přijímání nových znaků do fronty
  useEffect(() => {
    if (fullContent === '') {
      r.current = { ...r.current, queue: '', text: '', done: false, startTime: 0, charsShown: 0 };
      setDone(false);
      if (animRef.current) animRef.current.textContent = '';
      return;
    }
    if (r.current.done) return;
    const incoming = fullContent.slice(r.current.text.length + r.current.queue.length);
    if (incoming) r.current.queue += incoming;
  }, [fullContent]);

  // Animační smyčka — spustí se jednou při mountu, běží dokud není hotovo
  useEffect(() => {
    if (isPreloaded) return;

    const BUFFER_START = 15; // nakumuluj alespoň 15 znaků než začneš psát

    const tick = (timestamp: number) => {
      if (r.current.done) return;

      if (r.current.queue.length === 0 && !r.current.active) {
        // Vše zobrazeno + streaming skončil
        r.current.done = true;
        setDone(true);
        return;
      }

      if (r.current.queue.length > 0) {
        // Startup buffer — počkáme na zásobu znaků (jen při začátku)
        if (r.current.text.length === 0 && r.current.active && r.current.queue.length < BUFFER_START) {
          r.current.raf = requestAnimationFrame(tick);
          return;
        }

        // Inicializace time-based baseline
        if (r.current.startTime === 0) {
          r.current.startTime = timestamp;
          r.current.charsShown = r.current.text.length;
        }

        // Kolik znaků bychom měli mít zobrazeno teď dle uplynulého času
        const elapsed = timestamp - r.current.startTime;
        const target = r.current.charsShown + Math.floor(elapsed * CHARS_PER_SEC / 1000);
        const toReveal = Math.max(0, target - r.current.text.length);

        if (toReveal > 0) {
          const n = Math.min(toReveal, r.current.queue.length);
          r.current.text += r.current.queue.slice(0, n);
          r.current.queue = r.current.queue.slice(n);
          if (animRef.current) animRef.current.textContent = r.current.text;
        }
      }

      r.current.raf = requestAnimationFrame(tick);
    };

    r.current.raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(r.current.raf);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { done, animRef };
}

// ─── Markdown renderer ────────────────────────────────────────────────────────

const mdComponents = {
  p: ({ children }: any) => <p className="mb-2 last:mb-0">{children}</p>,
  strong: ({ children }: any) => <strong className="font-bold text-[var(--text-primary)]">{children}</strong>,
  em: ({ children }: any) => <em className="italic text-[var(--text-primary)]">{children}</em>,
  ul: ({ children }: any) => <ul className="space-y-0.5 my-1 pl-3">{children}</ul>,
  ol: ({ children }: any) => <ol className="space-y-0.5 my-1 pl-3 list-decimal">{children}</ol>,
  li: ({ children }: any) => <li className="text-[var(--text-primary)] before:content-['–'] before:mr-1.5 before:text-[var(--text-secondary)]">{children}</li>,
  hr: () => <hr className="border-[var(--border-subtle)] my-2" />,
  h3: ({ children }: any) => <h3 className="font-black text-[var(--text-primary)] text-xs uppercase tracking-wide mt-2 mb-1">{children}</h3>,
  code: ({ children }: any) => <code className="bg-[var(--bg-card)] px-1 rounded text-xs font-mono">{children}</code>,
};

// ─── Message bubble ───────────────────────────────────────────────────────────

export const MessageBubble: React.FC<{
  msg: ExtendedMessage;
  trades?: Trade[];
  dailyPreps?: DailyPrep[];
  dailyReviews?: DailyReview[];
  isStreaming?: boolean; // true jen pro poslední assistant zprávu během streamování
  onOpenTrade?: (trade: Trade) => void;
  onOpenJournal?: (date: string) => void;
}> = ({ msg, trades, dailyPreps, dailyReviews, isStreaming = false, onOpenTrade, onOpenJournal }) => {
  const isUser = msg.role === 'user';
  const rawContent = msg.role === 'assistant' ? stripAllRefs(msg.content) : msg.content;
  const { done, animRef } = useTypewriter(rawContent, isStreaming);

  return (
    <div className={`flex gap-2 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      {!isUser && (
        <div className="w-7 h-7 rounded-full bg-blue-600/20 border border-blue-500/30 flex items-center justify-center flex-shrink-0 mt-1">
          <Sparkles size={13} className="text-blue-400" />
        </div>
      )}
      <div className={`max-w-[85%] space-y-2 ${isUser ? 'items-end' : 'items-start'} flex flex-col`}>
        <div className={`px-4 py-3 rounded-2xl text-sm leading-relaxed ${
          isUser
            ? 'bg-blue-600 text-white rounded-tr-sm'
            : 'bg-[var(--bg-card)] border border-[var(--border-subtle)] text-[var(--text-primary)] rounded-tl-sm'
        }`}>
          {!rawContent && isStreaming ? (
            /* Čekáme na první chunk — spinner */
            <span className="flex items-center gap-2 text-[var(--text-secondary)]">
              <Loader2 size={13} className="animate-spin" />
              <span className="text-xs">Přemýšlím...</span>
            </span>
          ) : isUser ? (
            <span className="whitespace-pre-wrap">{rawContent}</span>
          ) : done ? (
            /* Animace skončila — jednou spustíme ReactMarkdown */
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
              {rawContent}
            </ReactMarkdown>
          ) : (
            /* Animace běží — přímé DOM zápisy, žádný re-render */
            <span className="whitespace-pre-wrap leading-relaxed">
              <span ref={animRef} />
              {/* Blikající kurzor */}
              <span
                className="inline-block w-[2px] h-[0.85em] bg-blue-400 ml-[2px] align-text-bottom opacity-100"
                style={{ animation: 'blink 1s step-end infinite' }}
              />
            </span>
          )}
        </div>

        {msg.tradeCards && msg.tradeCards.length > 0 && (
          <div className="w-full space-y-2">
            {msg.tradeCards.map(trade => (
              <TradeMiniCard key={trade.id} trade={trade} onClick={() => onOpenTrade?.(trade)} />
            ))}
          </div>
        )}

        {msg.prepCards && msg.prepCards.length > 0 && (
          <div className="w-full space-y-2">
            {msg.prepCards.map(prep => (
              <PrepMiniCard key={prep.id} prep={prep} onOpen={() => onOpenJournal?.(prep.date)} />
            ))}
          </div>
        )}

        {msg.reviewCards && msg.reviewCards.length > 0 && (
          <div className="w-full space-y-2">
            {msg.reviewCards.map(review => (
              <ReviewMiniCard key={review.id} review={review} onOpen={() => onOpenJournal?.(review.date)} />
            ))}
          </div>
        )}

        {msg.chartSpecs && msg.chartSpecs.length > 0 && trades && (
          <div className="w-full space-y-3">
            {msg.chartSpecs.map((spec, i) => (
              <DynamicChart key={i} spec={spec} trades={trades} dailyPreps={dailyPreps} dailyReviews={dailyReviews} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
