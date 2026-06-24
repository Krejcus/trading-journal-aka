/**
 * TradesyncerImportModal — import copier exportu (orders_history.csv).
 *
 * Tradesyncer = trade copier (1 leader → N follower účtů). Jeden CSV obsahuje
 * ordery napříč všemi účty. Modal:
 *   1. nahraje CSV → parseTradesyncerOrders (netting per účet),
 *   2. namapuje každý Tradesyncer účet → AlphaTrade účet (existující NEBO nový),
 *   3. ukáže preview: kolik obchodů, kolik se napáruje na AlphaBridge leadera,
 *   4. onConfirm(trades, newAccounts) — rodič vytvoří nové účty + uloží obchody.
 */
import React, { useState, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, UploadCloud, Loader2, CheckCircle2, AlertTriangle, Link2, Layers, ArrowRight } from 'lucide-react';
import { Account, Trade } from '../types';
import {
  parseTradesyncerOrders, buildTradesyncerTrades, isTradesyncerOrders,
  tsAccountKey, type TsAccount, type AccountMap,
} from '../services/tradesyncerImport';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  accounts: Account[];
  existingTrades: Trade[];
  isDark?: boolean;
  /** Nové obchody + nové účty k vytvoření (temp id). */
  onConfirm: (trades: Trade[], newAccounts: Account[]) => void;
}

const NEW = '__new__';
const fmtUsd = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const shortId = (an: string) => { const seg = (an.split(/[-_]/).pop() || an); return seg.length > 8 ? seg.slice(-8) : seg; };
const tempIdFor = (acc: TsAccount) => `tradesyncer-new-${acc.accountName || acc.account}`;
// Kategorie účtu pro seskupení kopií (Funded/Challenge zvlášť, nikdy dohromady).
// Priorita: phase → odvození z názvu (challka/challenge) → type. Fallback z názvu chrání
// před případem, kdy účtu chybí phase (jinak by Challenge spadl do Funded a slil se).
const categoryOf = (a: Account): string => {
  if (a.phase) return a.phase;
  if (/challka|challenge|chall\b/i.test(a.name || '')) return 'Challenge';
  return a.type === 'Funded' ? 'Funded' : a.type;
};
const suggestName = (acc: TsAccount) => `${acc.connectionName || 'Účet'} · ${shortId(acc.accountName)}`;

// Zapamatované mapování: Tradesyncer účet (stabilní accountName) → AlphaTrade account id.
// Díky tomu po prvním přiřazení import páruje napevno, nezávisle na názvech (i po přejmenování).
const SAVED_MAP_KEY = 'tradesyncer-account-map';
const loadSavedMap = (): Record<string, string> => {
  try { return JSON.parse(localStorage.getItem(SAVED_MAP_KEY) || '{}') || {}; } catch { return {}; }
};
const persistMapping = (entries: Record<string, string>) => {
  try {
    const merged = { ...loadSavedMap(), ...entries };
    localStorage.setItem(SAVED_MAP_KEY, JSON.stringify(merged));
  } catch { /* localStorage nedostupné — tichý fallback */ }
};

const TradesyncerImportModal: React.FC<Props> = ({ isOpen, onClose, accounts, existingTrades, isDark = true, onConfirm }) => {
  const [tsAccounts, setTsAccounts] = useState<TsAccount[] | null>(null);
  const [map, setMap] = useState<AccountMap>({});
  const [fileName, setFileName] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [doneCount, setDoneCount] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeAccounts = useMemo(() => accounts.filter(a => a.status === 'Active'), [accounts]);

  const reset = () => {
    setTsAccounts(null); setMap({}); setFileName(''); setParseError(null);
    setIsProcessing(false); setDoneCount(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };
  const handleClose = () => { reset(); onClose(); };

  const handleFile = (file: File) => {
    setParseError(null); setIsProcessing(true); setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result || '');
        const quickRows = text.split(/\r?\n/).slice(0, 2);
        if (!isTradesyncerOrders([Object.fromEntries((quickRows[0] || '').split(',').map((h, i) => [h.trim(), (quickRows[1] || '').split(',')[i]]))])) {
          setParseError('Tohle nevypadá jako Tradesyncer export (chybí sloupce leaderOrderId / connectionName / accountName / fillPrice).');
          setIsProcessing(false); return;
        }
        const parsed = parseTradesyncerOrders(text);
        if (!parsed.length) { setParseError('V souboru nejsou žádné vyplněné obchody.'); setIsProcessing(false); return; }
        // Default mapování — priorita: 1) zapamatované (accountName→id, i po přejmenování),
        // 2) shoda podle navrženého názvu, 3) „vytvořit nový".
        const byId = new Map(activeAccounts.map(a => [a.id, a]));
        const byName = new Map(activeAccounts.map(a => [a.name, a]));
        const saved = loadSavedMap();
        const m: AccountMap = {};
        for (const a of parsed) {
          const remembered = saved[a.accountName] ? byId.get(saved[a.accountName]) : undefined;
          const match = remembered || byName.get(suggestName(a));
          m[tsAccountKey(a)] = match
            ? { accountId: match.id, isNew: false, name: match.name, category: categoryOf(match) }
            : { accountId: tempIdFor(a), isNew: true, name: suggestName(a), category: 'Funded' };
        }
        setTsAccounts(parsed); setMap(m); setIsProcessing(false);
      } catch (e) {
        setParseError('Soubor se nepodařilo načíst: ' + (e as Error).message);
        setIsProcessing(false);
      }
    };
    reader.onerror = () => { setParseError('Chyba čtení souboru.'); setIsProcessing(false); };
    reader.readAsText(file);
  };

  const setMapping = (acc: TsAccount, value: string) => {
    const key = tsAccountKey(acc);
    setMap(prev => {
      if (value === NEW) return { ...prev, [key]: { accountId: tempIdFor(acc), isNew: true, name: prev[key]?.isNew ? prev[key].name : suggestName(acc), category: 'Funded' } };
      const found = activeAccounts.find(a => a.id === value);
      return { ...prev, [key]: { accountId: value, isNew: false, name: found?.name || '', category: found ? categoryOf(found) : 'Funded' } };
    });
  };
  const setNewName = (acc: TsAccount, name: string) => {
    const key = tsAccountKey(acc);
    setMap(prev => ({ ...prev, [key]: { ...prev[key], name } }));
  };

  // Build preview (dedup + link na AlphaBridge).
  const build = useMemo(() => {
    if (!tsAccounts) return null;
    return buildTradesyncerTrades(tsAccounts, map, existingTrades);
  }, [tsAccounts, map, existingTrades]);

  // Nové účty k vytvoření (unikátní temp id).
  const newAccounts: Account[] = useMemo(() => {
    if (!tsAccounts) return [];
    const seen = new Set<string>();
    const out: Account[] = [];
    for (const a of tsAccounts) {
      const t = map[tsAccountKey(a)];
      if (t?.isNew && !seen.has(t.accountId)) {
        seen.add(t.accountId);
        out.push({ id: t.accountId, name: t.name || suggestName(a), initialBalance: 50000, currency: 'USD', type: 'Funded', status: 'Active', createdAt: Date.now() } as Account);
      }
    }
    return out;
  }, [tsAccounts, map]);

  const handleConfirm = () => {
    if (!build || !build.trades.length || !tsAccounts) return;
    // Zapamatuj mapování existujících účtů (accountName→id) pro příští importy.
    const toPersist: Record<string, string> = {};
    for (const a of tsAccounts) {
      const t = map[tsAccountKey(a)];
      if (t && !t.isNew) toPersist[a.accountName] = t.accountId;
    }
    if (Object.keys(toPersist).length) persistMapping(toPersist);
    onConfirm(build.trades, newAccounts);
    setDoneCount(build.trades.length);
  };

  if (!isOpen) return null;

  const C = {
    bg: isDark ? '#0b0f1a' : '#ffffff',
    panel: isDark ? '#11182a' : '#f8fafc',
    border: isDark ? 'rgba(148,163,184,0.15)' : 'rgba(15,23,42,0.1)',
    text: isDark ? '#e2e8f0' : '#0f172a',
    sub: isDark ? '#94a3b8' : '#64748b',
    accent: '#22d3ee',
  };

  const totalPnl = tsAccounts?.reduce((s, a) => s + a.trades.reduce((x, t) => x + t.pnl, 0), 0) || 0;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        onClick={handleClose}
        style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(2,6,16,0.75)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      >
        <motion.div
          initial={{ scale: 0.96, y: 12, opacity: 0 }} animate={{ scale: 1, y: 0, opacity: 1 }} exit={{ scale: 0.96, opacity: 0 }}
          onClick={e => e.stopPropagation()}
          style={{ width: 'min(720px, 96vw)', maxHeight: '90vh', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 20, display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 30px 80px -20px rgba(0,0,0,0.7)' }}
        >
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 22px', borderBottom: `1px solid ${C.border}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(34,211,238,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Layers size={18} color={C.accent} />
              </div>
              <div>
                <div style={{ fontSize: 16, fontWeight: 800, color: C.text }}>Import z Tradesyncer</div>
                <div style={{ fontSize: 12, color: C.sub }}>Copier export → obchody per účet</div>
              </div>
            </div>
            <button onClick={handleClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.sub, padding: 6 }}><X size={20} /></button>
          </div>

          {/* Body */}
          <div style={{ padding: 22, overflowY: 'auto', flex: 1 }}>
            {doneCount != null ? (
              <div style={{ textAlign: 'center', padding: '32px 0' }}>
                <CheckCircle2 size={48} color="#10b981" style={{ margin: '0 auto 16px' }} />
                <div style={{ fontSize: 18, fontWeight: 800, color: C.text }}>Naimportováno {doneCount} obchodů</div>
                <div style={{ fontSize: 13, color: C.sub, marginTop: 6 }}>{newAccounts.length > 0 ? `+ vytvořeno ${newAccounts.length} nových účtů` : 'Bez nových účtů'}</div>
                <button onClick={handleClose} style={{ marginTop: 24, padding: '10px 28px', borderRadius: 10, border: 'none', background: C.accent, color: '#06121a', fontWeight: 700, cursor: 'pointer' }}>Hotovo</button>
              </div>
            ) : !tsAccounts ? (
              <>
                <div
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={e => e.preventDefault()}
                  onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}
                  style={{ border: `2px dashed ${C.border}`, borderRadius: 16, padding: '44px 20px', textAlign: 'center', cursor: 'pointer', background: C.panel }}
                >
                  {isProcessing ? <Loader2 size={32} color={C.accent} className="animate-spin" style={{ margin: '0 auto' }} /> : <UploadCloud size={32} color={C.accent} style={{ margin: '0 auto' }} />}
                  <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginTop: 12 }}>{fileName || 'Nahraj orders_history.csv'}</div>
                  <div style={{ fontSize: 12, color: C.sub, marginTop: 4 }}>Cockpit → Export. Přetáhni sem nebo klikni.</div>
                  <input ref={fileInputRef} type="file" accept=".csv" hidden onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
                </div>
                {parseError && (
                  <div style={{ marginTop: 14, display: 'flex', gap: 8, alignItems: 'flex-start', padding: 12, borderRadius: 10, background: 'rgba(239,68,68,0.1)', color: '#fca5a5', fontSize: 13 }}>
                    <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} /> {parseError}
                  </div>
                )}
              </>
            ) : (
              <>
                {/* Souhrn */}
                <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
                  <Stat label="Účtů" value={String(tsAccounts.length)} C={C} />
                  <Stat label="Obchodů" value={String(tsAccounts.reduce((s, a) => s + a.trades.length, 0))} C={C} />
                  <Stat label="PnL (gross)" value={fmtUsd(totalPnl)} C={C} accent={totalPnl >= 0 ? '#10b981' : '#ef4444'} />
                  {build && <Stat label="Napárováno" value={`${build.linked}×`} C={C} accent={C.accent} icon={<Link2 size={13} />} />}
                </div>

                {/* Mapování účtů */}
                <div style={{ fontSize: 12, fontWeight: 700, color: C.sub, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Mapování účtů</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {tsAccounts.map(acc => {
                    const t = map[tsAccountKey(acc)];
                    const accPnl = acc.trades.reduce((s, x) => s + x.pnl, 0);
                    return (
                      <div key={tsAccountKey(acc)} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          <div style={{ minWidth: 0, flex: '1 1 200px' }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{acc.connectionName || '—'}</div>
                            <div style={{ fontSize: 11, color: C.sub, fontFamily: 'monospace' }}>{acc.accountName}</div>
                          </div>
                          <div style={{ fontSize: 12, color: C.sub, whiteSpace: 'nowrap' }}>{acc.trades.length} obch. · <span style={{ color: accPnl >= 0 ? '#10b981' : '#ef4444', fontWeight: 700 }}>{fmtUsd(accPnl)}</span></div>
                          <ArrowRight size={15} color={C.sub} style={{ flexShrink: 0 }} />
                          <select
                            value={t?.isNew ? NEW : t?.accountId || NEW}
                            onChange={e => setMapping(acc, e.target.value)}
                            style={{ flex: '1 1 160px', padding: '8px 10px', borderRadius: 8, background: C.bg, color: C.text, border: `1px solid ${C.border}`, fontSize: 12, cursor: 'pointer' }}
                          >
                            <option value={NEW}>＋ Vytvořit nový účet</option>
                            {activeAccounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                          </select>
                        </div>
                        {t?.isNew && (
                          <input
                            value={t.name}
                            onChange={e => setNewName(acc, e.target.value)}
                            placeholder="Název nového účtu"
                            style={{ marginTop: 8, width: '100%', padding: '7px 10px', borderRadius: 8, background: C.bg, color: C.text, border: `1px solid ${C.border}`, fontSize: 12 }}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Napáruje se na — náhled AlphaBridge leaderů (na co se to naváže) */}
                {build && build.matchedLeaders.length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: C.sub, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Link2 size={13} color={C.accent} /> Napáruje se na
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {build.matchedLeaders.map(l => {
                        const isLong = String(l.direction || '').toLowerCase() === 'long';
                        return (
                          <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 12, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: 10 }}>
                            {l.screenshot ? (
                              <img src={l.screenshot} alt="" style={{ width: 72, height: 48, objectFit: 'cover', borderRadius: 8, flexShrink: 0, border: `1px solid ${C.border}` }} />
                            ) : (
                              <div style={{ width: 72, height: 48, borderRadius: 8, flexShrink: 0, background: C.bg, border: `1px dashed ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: C.sub }}>bez screenu</div>
                            )}
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                <span style={{ fontSize: 11, fontWeight: 800, color: isLong ? '#10b981' : '#ef4444' }}>{isLong ? '▲' : '▼'} {l.direction || '—'}</span>
                                {l.entry != null && <span style={{ fontSize: 12, fontFamily: 'monospace', color: C.text }}>@ {l.entry}</span>}
                                {l.rr != null && <span style={{ fontSize: 11, color: C.accent, fontWeight: 700 }}>{l.rr}R</span>}
                              </div>
                              <div style={{ fontSize: 11, color: C.sub, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {[l.setup, l.session].filter(Boolean).join(' · ') || 'AlphaBridge obchod'}
                              </div>
                            </div>
                            <div style={{ fontSize: 12, fontWeight: 800, color: C.accent, flexShrink: 0 }}>×{l.count}</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Link / dedup info */}
                {build && (
                  <div style={{ marginTop: 16, padding: 12, borderRadius: 10, background: 'rgba(34,211,238,0.06)', border: `1px solid ${C.border}`, fontSize: 12, color: C.sub, lineHeight: 1.6 }}>
                    <div><Link2 size={12} style={{ display: 'inline', verticalAlign: -1 }} /> <b style={{ color: C.text }}>{build.linked}</b> obchodů napárováno na AlphaBridge leadera (zdědí SL/TP/R:R/screen/tagy)</div>
                    <div><b style={{ color: C.text }}>{build.executionOnly}</b> jen exekuce (bez leadera) → <b style={{ color: '#f59e0b' }}>Invalid</b> · <b style={{ color: C.text }}>{build.duplicates}</b> duplicit přeskočeno{build.mergedLeader > 0 && <> · <b style={{ color: C.text }}>{build.mergedLeader}</b> splynulo s leaderem</>}</div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Footer */}
          {tsAccounts && doneCount == null && (
            <div style={{ padding: 18, borderTop: `1px solid ${C.border}`, display: 'flex', gap: 10, justifyContent: 'space-between', alignItems: 'center' }}>
              <button onClick={reset} style={{ padding: '10px 16px', borderRadius: 10, border: `1px solid ${C.border}`, background: 'none', color: C.sub, fontWeight: 600, cursor: 'pointer', fontSize: 13 }}>← Jiný soubor</button>
              <button
                onClick={handleConfirm}
                disabled={!build || !build.trades.length}
                style={{ padding: '11px 26px', borderRadius: 10, border: 'none', background: build?.trades.length ? C.accent : C.border, color: build?.trades.length ? '#06121a' : C.sub, fontWeight: 800, cursor: build?.trades.length ? 'pointer' : 'not-allowed', fontSize: 14 }}
              >
                Importovat {build?.trades.length || 0} obchodů
              </button>
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};

const Stat: React.FC<{ label: string; value: string; C: any; accent?: string; icon?: React.ReactNode }> = ({ label, value, C, accent, icon }) => (
  <div style={{ flex: '1 1 auto', minWidth: 90, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 12px' }}>
    <div style={{ fontSize: 11, color: C.sub, display: 'flex', alignItems: 'center', gap: 4 }}>{icon}{label}</div>
    <div style={{ fontSize: 17, fontWeight: 800, color: accent || C.text, marginTop: 2 }}>{value}</div>
  </div>
);

export default TradesyncerImportModal;
