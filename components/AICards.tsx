import React, { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  X, ZoomIn, ChevronLeft, ChevronRight, TrendingUp, TrendingDown,
  Calendar, ExternalLink, Moon, Sun, CheckCircle2, XCircle, Target,
  Brain, Star, Loader2, Sparkles, Shield, FlaskConical, ListChecks, Flag, Check,
  ChevronDown, ChevronUp, BarChart3, BookOpen, FileText, Pencil, Trash2, Zap,
} from 'lucide-react';
import type { Trade, DailyPrep, DailyReview } from '../types';
import { stripAllRefs, type AIMessage, type ChartSpec, type SuggestedAction } from '../services/aiService';
import { DynamicChart } from './AICharts';

// ─── Extended message type ────────────────────────────────────────────────────

export type ExtendedMessage = AIMessage & {
  tradeCards?: Trade[];
  prepCards?: DailyPrep[];
  reviewCards?: DailyReview[];
  chartSpecs?: ChartSpec[];
  followups?: string[];
  /** Akční návrhy z Coache — Iron Rules, experimenty, cíle */
  actions?: SuggestedAction[];
  /** ID akcí které user už aplikoval — slouží jako vizuální indikátor */
  appliedActionIds?: number[];
  aiModel?: 'analytical' | 'fast';
  isSystemEvent?: boolean;
  systemEventText?: string;
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

// Rychlost psaní: 75 zn/s působilo "přemýšlivě", ale 600znaková odpověď se
// dopisovala 8 s PO doručení — uměle zpomalovalo coache. 400 zn/s = stále plynulé,
// ale text drží krok se streamem.
const CHARS_PER_SEC = 200;

function useTypewriter(fullContent: string, active: boolean) {
  const isPreloaded = !active && fullContent !== '';
  const [done, setDone] = useState(isPreloaded);
  const [displayText, setDisplayText] = useState(isPreloaded ? fullContent : '');

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
      setDisplayText('');
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
        let toReveal = Math.max(0, target - r.current.text.length);
        // Plynulé dohánění místo skokového dumpu: když stream (Haiku) předbíhá
        // psaní, zrychli HLADCE — ber ~1/12 backlogu za frame. Tím to teče
        // písmeno po písmenu i při rychlém streamu, nikdy neskočí celá věta.
        if (r.current.queue.length > 0) {
          toReveal = Math.max(toReveal, Math.ceil(r.current.queue.length / 12));
        }

        if (toReveal > 0) {
          // Odhaluj PO ZNACÍCH (písmeno po písmenu) — jako chat tady.
          const n = Math.min(toReveal, r.current.queue.length);
          if (n > 0) {
            r.current.text += r.current.queue.slice(0, n);
            r.current.queue = r.current.queue.slice(n);
            // Aktualizujeme React state → ReactMarkdown renderuje průběžně
            setDisplayText(r.current.text);
          }
        }
      }

      r.current.raf = requestAnimationFrame(tick);
    };

    r.current.raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(r.current.raf);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { done, displayText };
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

// ─── Action panel ─────────────────────────────────────────────────────────────
// Renderuje SuggestedAction[] jako klikatelné karty pod zprávou.
// Klik → onApplyAction(action, index) → App pohltí (přidá Iron Rule / cíl / atd.)
// Po aplikaci se karta vizuálně označí jako "applied".

const ActionIcon: React.FC<{ type: SuggestedAction['type']; size?: number }> = ({ type, size = 14 }) => {
  switch (type) {
    case 'rule': return <Shield size={size} strokeWidth={2.5} />;
    case 'experiment': return <FlaskConical size={size} strokeWidth={2.5} />;
    case 'goal': return <Flag size={size} strokeWidth={2.5} />;
    case 'checklist': return <ListChecks size={size} strokeWidth={2.5} />;
    case 'modify_rule': return <Pencil size={size} strokeWidth={2.5} />;
    case 'remove_rule': return <Trash2 size={size} strokeWidth={2.5} />;
  }
};

const ActionTypeLabel: Record<SuggestedAction['type'], string> = {
  rule: 'Iron Rule',
  experiment: 'Experiment',
  goal: 'Cíl',
  checklist: 'Checklist',
  modify_rule: 'Úprava pravidla',
  remove_rule: 'Zrušit pravidlo',
};

/** Vysvětlí kde se akce uloží — zobrazí se jako tooltip / inline hint pod tlačítkem. */
const ActionDestinationHint: Record<SuggestedAction['type'], string> = {
  rule: 'Uloží se do Settings → Iron Rules',
  experiment: 'Time-boxed pravidlo v Settings → Iron Rules',
  goal: 'Uloží se do Goals',
  checklist: 'Uloží se jako Iron Rule s odrážkami v Settings → Pravidla',
  modify_rule: 'Změní existující pravidlo v Settings → Iron Rules',
  remove_rule: 'Odebere pravidlo ze Settings → Iron Rules',
};

export const ActionPanel: React.FC<{
  actions: SuggestedAction[];
  appliedIds: number[];
  /** Sada labelů již existujících Iron Rules a Goals — pokud action.label matchuje,
   *  považujeme akci za "applied" i napříč reloady/přepnutími konverzace. */
  existingLabels?: Set<string>;
  onApply: (action: SuggestedAction, index: number) => void;
}> = ({ actions, appliedIds, existingLabels, onApply }) => {
  if (!actions || actions.length === 0) return null;

  /** Vrátí pravdivý label co by se uložil do Iron Rules / Goals, podle typu akce.
   *  Musí být v sync s logikou v App.tsx onApplyAction handler. */
  const persistedLabel = (action: SuggestedAction): string => {
    if (action.type === 'experiment' && action.duration) return `⏱ [${action.duration}] ${action.label}`;
    if (action.type === 'checklist') return `📋 ${action.label}`;
    return action.label;
  };

  return (
    <div className="w-full space-y-1.5">
      {actions.map((action, i) => {
        // Applied pokud (a) right-now v session kliknutý, NEBO (b) label už existuje v Iron Rules/Goals.
        // (b) přežije reload — pravidlo zůstává v Supabase, načte se zpět.
        // U checklistu porovnáváme jen prefix (text může mít multi-line items).
        const label = persistedLabel(action);
        // modify_rule/remove_rule cílí existující pravidlo — "applied" řešíme jen přes
        // session click (persistedMatch by mátl: u modify je label nový text, u remove naopak).
        const isRuleEdit = action.type === 'modify_rule' || action.type === 'remove_rule';
        const persistedMatch = !isRuleEdit && existingLabels
          ? (action.type === 'checklist'
              ? Array.from(existingLabels).some(l => l.startsWith(label))
              : existingLabels.has(label))
          : false;
        const applied = appliedIds.includes(i) || persistedMatch;
        // remove_rule je vždy destruktivní → červené, bez ohledu na severity.
        const sev = action.type === 'remove_rule' ? 'critical' : (action.severity || 'standard');
        const severityClasses = sev === 'critical'
          ? 'border-rose-500/30 bg-rose-500/[0.05]'
          : sev === 'optional'
            ? 'border-slate-500/20 bg-slate-500/[0.03]'
            : 'border-blue-500/25 bg-blue-500/[0.04]';
        const btnClasses = applied
          ? 'bg-emerald-500 text-white shadow-emerald-500/30 cursor-default'
          : sev === 'critical'
            ? 'bg-rose-500 hover:bg-rose-600 text-white shadow-rose-500/30'
            : sev === 'optional'
              ? 'bg-slate-200 hover:bg-slate-300 text-slate-700'
              : 'bg-blue-500 hover:bg-blue-600 text-white shadow-blue-500/30';
        return (
          <div
            key={i}
            className={`flex items-start gap-3 p-3 rounded-xl border transition-all ${severityClasses}`}
          >
            <div className={`p-2 rounded-lg shrink-0 ${
              sev === 'critical' ? 'bg-rose-500/15 text-rose-500'
              : sev === 'optional' ? 'bg-slate-500/15 text-slate-500'
              : 'bg-blue-500/15 text-blue-500'
            }`}>
              <ActionIcon type={action.type} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className="text-[8px] font-black uppercase tracking-[0.2em] text-[var(--text-muted)]">
                  {ActionTypeLabel[action.type]}
                </span>
                {action.duration && (
                  <span className="text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 border border-amber-500/20">
                    {action.duration}
                  </span>
                )}
              </div>
              {action.type === 'modify_rule' && action.oldLabel ? (
                <div className="space-y-0.5">
                  <p className="text-[11px] font-medium text-[var(--text-muted)] leading-snug line-through opacity-70">
                    {action.oldLabel}
                  </p>
                  <p className="text-[12px] font-bold text-[var(--text-primary)] leading-snug">
                    → {action.label}
                  </p>
                </div>
              ) : action.type === 'remove_rule' ? (
                <p className="text-[12px] font-bold text-[var(--text-primary)] leading-snug line-through opacity-80">
                  {action.oldLabel || action.label}
                </p>
              ) : (
                <p className="text-[12px] font-bold text-[var(--text-primary)] leading-snug">
                  {action.label}
                </p>
              )}
              {action.items && action.items.length > 0 && (
                <ul className="mt-2 space-y-0.5">
                  {action.items.map((item, k) => (
                    <li key={k} className="text-[10px] text-[var(--text-secondary)] flex items-start gap-1.5">
                      <span className="text-blue-500 shrink-0">▢</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <button
              onClick={() => !applied && onApply(action, i)}
              disabled={applied}
              title={applied ? 'Akce již aplikována' : ActionDestinationHint[action.type]}
              className={`shrink-0 px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all shadow-md flex items-center gap-1.5 ${btnClasses}`}
            >
              {applied ? (
                <>
                  <Check size={10} strokeWidth={3} />
                  {action.type === 'modify_rule' ? 'Změněno' : action.type === 'remove_rule' ? 'Zrušeno' : 'Přidáno'}
                </>
              ) : action.type === 'modify_rule' ? (
                <>Změnit</>
              ) : action.type === 'remove_rule' ? (
                <>Zrušit</>
              ) : (
                <>+ Přidat</>
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
};

// ─── Collapsible card section ─────────────────────────────────────────────────
// Když je víc než PRAH karet, sbalí je do collapsable bloku s ikonou a počtem.
// Méně než PRAH → renderuje karty inline (žádný zbytečný UI overhead).

const CollapsibleCardSection: React.FC<{
  icon: React.ReactNode;
  label: string;
  count: number;
  children: React.ReactNode;
}> = ({ icon, label, count, children }) => {
  // VŽDY sbalené defaultně — pod zprávou je jen čistý kompaktní řádek "Použité X (N)",
  // uživatel si rozbalí když chce vidět karty. (Dřív se ≤3 karty renderovaly natvrdo rozbalené.)
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="w-full">
      <button
        onClick={() => setExpanded(!expanded)}
        className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl border transition-all ${
          expanded
            ? 'bg-blue-500/[0.05] border-blue-500/20 text-[var(--text-primary)] mb-2'
            : 'bg-[var(--bg-card)] border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-blue-500/[0.05] hover:border-blue-500/15'
        }`}
      >
        <div className="flex items-center gap-2">
          {icon}
          <span className="text-[11px] font-black uppercase tracking-widest">{label}</span>
          <span className="text-[9px] font-mono font-black px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-500">
            {count}
          </span>
        </div>
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {expanded && <div className="space-y-2">{children}</div>}
    </div>
  );
};

export const MessageBubble: React.FC<{
  msg: ExtendedMessage;
  trades?: Trade[];
  dailyPreps?: DailyPrep[];
  dailyReviews?: DailyReview[];
  isStreaming?: boolean; // true jen pro poslední assistant zprávu během streamování
  toolStatus?: string | null; // např. "🔍 Hledám 'revenge'…" během tool use
  onOpenTrade?: (trade: Trade) => void;
  onOpenJournal?: (date: string) => void;
  onFollowup?: (text: string) => void;
  /** Klik na action card — app aplikuje akci (přidá rule/cíl) */
  onApplyAction?: (action: SuggestedAction, messageIndex: number, actionIndex: number) => void;
  /** Index této zprávy v rodičovském messages[] — kvůli appliedActionIds keying */
  messageIndex?: number;
  /** Labely již existujících Iron Rules + Goals (kvůli derivovanému "applied" stavu).
   *  Předává AICoachPage z props. */
  existingActionLabels?: Set<string>;
}> = ({ msg, trades, dailyPreps, dailyReviews, isStreaming = false, toolStatus = null, onOpenTrade, onOpenJournal, onFollowup, onApplyAction, messageIndex, existingActionLabels }) => {
  const isUser = msg.role === 'user';
  // Strip [CONTEXT]...[/CONTEXT] block from user messages — it's the hidden analytical context
  // sent from "Analyze with AI" buttons. AI receives it, user shouldn't see the noise.
  const stripContextBlock = (text: string): string =>
    text.replace(/\[CONTEXT\][\s\S]*?\[\/CONTEXT\]\s*/g, '').trim();
  const rawContent = msg.role === 'assistant'
    ? stripAllRefs(msg.content || '')
    : stripContextBlock(msg.content || '');
  // POZOR: hook MUSÍ být volaný před jakýmkoli early returnem (rules-of-hooks). Dřív byl AŽ
  // za `if (msg.isSystemEvent) return`, takže se volal podmíněně → při přepnutí typu zprávy
  // se měnilo pořadí hooků a React mohl rozhodit stav.
  const { done, displayText } = useTypewriter(rawContent, isStreaming);

  if (msg.isSystemEvent) {
    return (
      <div className="w-full flex justify-center my-2 px-4">
        <span className="text-xs text-[var(--text-secondary)] font-medium text-center opacity-85 select-none transition-colors duration-200">
          {msg.systemEventText}
        </span>
      </div>
    );
  }

  return (
    <div className={`flex gap-2 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      {!isUser && (
        <div
          className={`w-9 h-9 rounded-full border-2 flex items-center justify-center flex-shrink-0 mt-1 overflow-hidden coach-avatar-container ${
            (msg.aiModel || 'analytical') === 'fast'
              ? 'bg-amber-500/10 border-amber-500/50 coach-avatar-fast'
              : 'bg-violet-500/10 border-violet-500/50 coach-avatar-analytical'
          } ${
            isStreaming ? 'coach-avatar-talk' : 'coach-avatar-breath'
          }`}
          title={(msg.aiModel || 'analytical') === 'fast' ? 'Rychlý kouč (Haiku 4.5)' : 'Analytický kouč (Sonnet 4.6)'}
        >
          <img
            src={(msg.aiModel || 'analytical') === 'fast' ? '/fast-coach-option1-trans.png' : '/analytical-coach-option1-trans.png'}
            alt={(msg.aiModel || 'analytical') === 'fast' ? 'Haiku' : 'Sonnet'}
            className="w-full h-full object-cover animate-none"
          />
        </div>
      )}
      <div className={`max-w-[85%] space-y-2 ${isUser ? 'items-end' : 'items-start'} flex flex-col`}>
        <div className={`px-4 py-3 rounded-2xl text-sm leading-relaxed ${
          isUser
            ? 'bg-blue-600 text-white rounded-tr-sm'
            : 'bg-[var(--bg-card)] border border-[var(--border-subtle)] text-[var(--text-primary)] rounded-tl-sm'
        }`}>
          {!rawContent && isStreaming ? (
            /* Čekáme na první chunk — spinner s tool statusem pokud agent volá nástroje */
            <span className="flex items-center gap-2 text-[var(--text-secondary)]">
              <Loader2 size={13} className="animate-spin" />
              <span className="text-xs">{toolStatus || 'Přemýšlím...'}</span>
            </span>
          ) : isUser ? (
            <span className="whitespace-pre-wrap">{rawContent}</span>
          ) : (
            /* Markdown rendering — živě i po dokončení (žádné přerovnání na konci,
               žádný kurzor). Plynulost zajišťuje frame-by-frame pin scrollu v AICoachPage. */
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
              {done ? rawContent : displayText}
            </ReactMarkdown>
          )}
        </div>

        {/* Tool status badge — shows while agent is mid-stream invoking tools */}
        {!isUser && isStreaming && toolStatus && rawContent && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-500 text-[10px] font-bold">
            <Loader2 size={10} className="animate-spin" />
            <span>{toolStatus}</span>
          </div>
        )}

        {/* Použité podklady — obchody + přípravy + audity dohromady v jedné sbalené sekci. */}
        {((msg.tradeCards?.length || 0) + (msg.prepCards?.length || 0) + (msg.reviewCards?.length || 0)) > 0 && (
          <CollapsibleCardSection
            icon={<BarChart3 size={13} className="text-blue-500" />}
            label="Použité podklady"
            count={(msg.tradeCards?.length || 0) + (msg.prepCards?.length || 0) + (msg.reviewCards?.length || 0)}
          >
            {msg.tradeCards?.map(trade => (
              <TradeMiniCard key={`t-${trade.id}`} trade={trade} onClick={() => onOpenTrade?.(trade)} />
            ))}
            {msg.prepCards?.map(prep => (
              <PrepMiniCard key={`p-${prep.id}`} prep={prep} onOpen={() => onOpenJournal?.(prep.date)} />
            ))}
            {msg.reviewCards?.map(review => (
              <ReviewMiniCard key={`r-${review.id}`} review={review} onOpen={() => onOpenJournal?.(review.date)} />
            ))}
          </CollapsibleCardSection>
        )}

        {msg.chartSpecs && msg.chartSpecs.length > 0 && trades && (
          <div className="w-full space-y-3">
            {msg.chartSpecs.map((spec, i) => (
              <DynamicChart key={i} spec={spec} trades={trades} dailyPreps={dailyPreps} dailyReviews={dailyReviews} />
            ))}
          </div>
        )}

        {/* Action panel — Coach generates [ACTION:{...}] markers.
            Renderujeme pouze po dokončení streamu, aby user neklikal half-parsed akce.
            Sbalené defaultně (jako karty) — uživatel si rozbalí. */}
        {!isUser && !isStreaming && msg.actions && msg.actions.length > 0 && onApplyAction && messageIndex !== undefined && (
          <CollapsibleCardSection
            icon={<Target size={13} className="text-blue-500" />}
            label="Doporučené akce"
            count={msg.actions.length}
          >
            <ActionPanel
              actions={msg.actions}
              appliedIds={msg.appliedActionIds || []}
              existingLabels={existingActionLabels}
              onApply={(action, idx) => onApplyAction(action, messageIndex, idx)}
            />
          </CollapsibleCardSection>
        )}

        {/* Follow-up suggestion pills — Coach generates these as [FOLLOWUP:text] at message end.
            Only render after the message stops streaming so user doesn't click a half-typed suggestion. */}
        {!isUser && !isStreaming && msg.followups && msg.followups.length > 0 && onFollowup && (
          <div className="flex flex-wrap gap-1.5 mt-1">
            {msg.followups.map((text, i) => (
              <button
                key={i}
                onClick={() => onFollowup(text)}
                className="group inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-blue-500/10 hover:bg-blue-500/20 text-blue-500 text-xs font-bold border border-blue-500/20 hover:border-blue-500/40 transition-all active:scale-95"
                title="Pošle tento dotaz Coachovi"
              >
                <span>{text}</span>
                <span className="text-[10px] opacity-50 group-hover:opacity-100 transition-opacity">→</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
