import React, { useState, useMemo, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Papa from 'papaparse';
import { X, UploadCloud, Loader2, CheckCircle2, AlertTriangle, FileText, TrendingUp, TrendingDown, Sparkles, ChevronDown } from 'lucide-react';
import { Account, Trade } from '../types';
import { parseTradovateFills, isTradovateFills, applyCashHistory, applyEstimatedFees, isCashHistory, TradovateImportResult, FeeRates } from '../services/tradovateImport';
import { isLegacyXlsFile, LEGACY_XLS_MESSAGE, MAX_IMPORT_FILE_BYTES, readExcelRows } from '../services/excelImport';

// --- Uložené sazby poplatků per účet (poplatek/strana je pro účet konstantní) ---
// Díky tomu stačí Cash History nahrát jednou; další importy spočítají net P&L samy.
// Tradovate fees jsou stejné napříč všemi účty/prop firmami u stejného brokera.
// Ukládáme tedy GLOBÁLNĚ (per user/zařízení), s account-specific override jako fallback.
const GLOBAL_FEE_KEY = 'tradovate-fee-rates-global';
const feeRatesKey = (accountId: string) => `tradovate-fee-rates-${accountId}`;

function readKey(key: string): FeeRates | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.rates && Object.keys(parsed.rates).length > 0 ? parsed.rates as FeeRates : null;
  } catch { return null; }
}

function loadFeeRates(accountId: string): FeeRates | null {
  // Merge global + account-specific (account override má přednost).
  const global = readKey(GLOBAL_FEE_KEY) || {};
  const account = readKey(feeRatesKey(accountId)) || {};
  const merged = { ...global, ...account };
  return Object.keys(merged).length > 0 ? merged : null;
}

function saveFeeRates(accountId: string, rates: FeeRates) {
  try {
    // 1) global — sdíleno napříč všemi účty
    const globalExisting = readKey(GLOBAL_FEE_KEY) || {};
    const globalMerged = { ...globalExisting, ...rates };
    localStorage.setItem(GLOBAL_FEE_KEY, JSON.stringify({ rates: globalMerged, updatedAt: Date.now() }));
    // 2) account-specific — pro audit/budoucnost (kdyby user měl jiné rates per účet)
    const accountExisting = readKey(feeRatesKey(accountId)) || {};
    const accountMerged = { ...accountExisting, ...rates };
    localStorage.setItem(feeRatesKey(accountId), JSON.stringify({ rates: accountMerged, updatedAt: Date.now() }));
  } catch { /* localStorage nedostupné — tichý fallback */ }
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  accounts: Account[];
  defaultAccountId?: string;
  existingTrades: Trade[];
  isDark?: boolean;
  /** Zavolá se s NOVÝMI (po dedup) obchody k uložení. */
  onConfirm: (trades: Trade[]) => void;
  /** Spustí průvodce doplněním (screenshoty/konfluence) po importu. */
  onStartEnrich?: () => void;
}

const fmtUsd = (n: number) =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const TradovateImportModal: React.FC<Props> = ({
  isOpen, onClose, accounts, defaultAccountId, existingTrades, isDark = true, onConfirm, onStartEnrich,
}) => {
  const [accountId, setAccountId] = useState<string>(defaultAccountId || accounts[0]?.id || '');
  const [rawRows, setRawRows] = useState<any[] | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [importedCount, setImportedCount] = useState<number | null>(null); // success screen
  const [showSkipped, setShowSkipped] = useState(false);
  const [cashRows, setCashRows] = useState<any[] | null>(null);
  const [cashFileName, setCashFileName] = useState<string>('');
  const [cashError, setCashError] = useState<string | null>(null);
  const [showCashUpload, setShowCashUpload] = useState(false); // ruční „obnovit" i když máme uložené sazby
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cashInputRef = useRef<HTMLInputElement>(null);

  // Přepočítej párování při změně účtu (accountId je zapečený do obchodů).
  // Pokud je nahraný Cash History, dopáruj poplatky + přesný P&L (gross → net).
  const result: TradovateImportResult | null = useMemo(() => {
    if (!rawRows || !accountId) return null;
    try {
      const base = parseTradovateFills(rawRows, accountId);
      if (cashRows) return applyCashHistory(base, cashRows);
      // Bez Cash History: zkus uložené sazby poplatků pro tenhle účet → net odhad.
      const stored = loadFeeRates(accountId);
      return stored ? applyEstimatedFees(base, stored) : base;
    } catch {
      return null;
    }
  }, [rawRows, accountId, cashRows]);

  // Když přišly přesné sazby z Cash History, ulož je pro tenhle účet do budoucna.
  useEffect(() => {
    const rates = result?.summary.feeRates;
    if (result?.summary.feesApplied && !result.summary.feesEstimated && rates && Object.keys(rates).length > 0) {
      saveFeeRates(accountId, rates);
    }
  }, [result, accountId]);

  // Dedup proti existujícím obchodům (stejné id + účet už uložené).
  const { newTrades, dupCount } = useMemo(() => {
    if (!result) return { newTrades: [] as Trade[], dupCount: 0 };
    const existingIds = new Set(
      existingTrades.filter(t => t.accountId === accountId).map(t => String(t.id))
    );
    const fresh = result.trades.filter(t => !existingIds.has(String(t.id)));
    return { newTrades: fresh, dupCount: result.trades.length - fresh.length };
  }, [result, existingTrades, accountId]);

  const reset = () => {
    setRawRows(null);
    setFileName('');
    setParseError(null);
    setImportedCount(null);
    setShowSkipped(false);
    setCashRows(null);
    setCashFileName('');
    setCashError(null);
    setShowCashUpload(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (cashInputRef.current) cashInputRef.current.value = '';
  };

  const handleClose = () => { reset(); onClose(); };

  /** Přečte jeden soubor (CSV i XLSX) na pole řádků s hlavičkou. */
  const readFileRows = (file: File): Promise<any[]> => new Promise((resolve, reject) => {
    if (isLegacyXlsFile(file.name)) {
      reject(new Error(LEGACY_XLS_MESSAGE));
      return;
    }
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      reject(new Error('Soubor je příliš velký. Maximum je 10 MB.'));
      return;
    }
    const isExcel = file.name.toLowerCase().endsWith('.xlsx');
    if (isExcel) {
      readExcelRows(file).then(resolve).catch(reject);
    } else {
      Papa.parse(file, {
        header: true, skipEmptyLines: true,
        complete: (res) => resolve(res.data as any[]),
        error: () => reject(new Error('parse error')),
      });
    }
  });

  /** Přijme 1–2 soubory naráz a sám rozpozná, který je Orders a který Cash History. */
  const handleFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;
    setIsProcessing(true);
    setParseError(null);
    setCashError(null);

    try {
      let foundOrders = false;
      let foundCash = false;
      for (const file of files) {
        let rows: any[];
        try { rows = await readFileRows(file); }
        catch (error) {
          setParseError(error instanceof Error && error.message === LEGACY_XLS_MESSAGE
            ? LEGACY_XLS_MESSAGE
            : `Chyba při čtení souboru ${file.name}.`);
          continue;
        }
        if (!rows || rows.length === 0) continue;
        if (isCashHistory(rows)) {
          setCashRows(rows); setCashFileName(file.name); foundCash = true;
        } else if (isTradovateFills(rows)) {
          setRawRows(rows); setFileName(file.name); foundOrders = true;
        }
      }
      if (!foundOrders && !foundCash) {
        setParseError('Nic z toho nevypadá jako Tradovate export. Stáhni Account reports → Orders (povinný) a Cash history (volitelný), ne Performance.');
      } else if (!foundOrders && foundCash) {
        setParseError('Nahrál jsi jen Cash History — chybí Orders export, ten je povinný. Přidej i Orders.');
      }
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCashFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setCashError(null);
    setCashFileName(file.name);

    const finish = (rows: any[]) => {
      if (!rows || rows.length === 0) { setCashError('Soubor je prázdný.'); return; }
      if (!isCashHistory(rows)) {
        setCashError('Tohle nevypadá jako Cash History (chybí sloupec Cash Change Type).');
        setCashFileName('');
        return;
      }
      setCashRows(rows);
    };

    const isExcel = file.name.toLowerCase().endsWith('.xlsx');
    if (isLegacyXlsFile(file.name)) {
      setCashError(LEGACY_XLS_MESSAGE);
    } else if (file.size > MAX_IMPORT_FILE_BYTES) {
      setCashError('Soubor je příliš velký. Maximum je 10 MB.');
    } else if (isExcel) {
      readExcelRows(file).then(finish).catch(() => setCashError('Chyba při čtení Excel souboru.'));
    } else {
      Papa.parse(file, {
        header: true, skipEmptyLines: true,
        complete: (res) => finish(res.data as any[]),
        error: () => setCashError('Chyba při čtení CSV souboru.'),
      });
    }
  };

  const handleConfirm = () => {
    if (newTrades.length === 0) return;
    onConfirm(newTrades);
    setImportedCount(newTrades.length); // přepni na success screen
  };

  const handleEnrichNow = () => {
    handleClose();
    onStartEnrich?.();
  };

  if (!isOpen) return null;

  const panel = isDark ? 'bg-slate-900 border-white/10' : 'bg-white border-slate-200';
  const text = isDark ? 'text-white' : 'text-slate-900';
  const subText = isDark ? 'text-slate-400' : 'text-slate-500';
  const inputBg = isDark ? 'bg-slate-800 border-white/10 text-white' : 'bg-slate-50 border-slate-200 text-slate-900';

  const summary = result?.summary;
  const pnlPositive = (summary?.totalPnL ?? 0) >= 0;

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        onClick={handleClose}
      >
        <motion.div
          className={`relative w-full max-w-lg rounded-3xl border shadow-2xl overflow-hidden ${panel}`}
          initial={{ scale: 0.95, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, y: 20 }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between p-5 border-b border-white/10">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-blue-500/10 border border-blue-500/30">
                <UploadCloud size={18} className="text-blue-500" />
              </div>
              <div>
                <h2 className={`text-sm font-black uppercase tracking-wider ${text}`}>Import z Tradovate</h2>
                <p className={`text-[10px] ${subText}`}>Account reports → Orders → Download Report</p>
              </div>
            </div>
            <button onClick={handleClose} className={`p-1.5 rounded-lg hover:bg-white/10 transition-all ${subText}`}>
              <X size={18} />
            </button>
          </div>

          {importedCount !== null ? (
            <div className="p-6 space-y-5 text-center">
              <div className="mx-auto w-14 h-14 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
                <CheckCircle2 size={26} className="text-emerald-500" />
              </div>
              <div>
                <h3 className={`text-base font-black ${text}`}>{importedCount} obchodů naimportováno</h3>
                <p className={`mt-1.5 text-xs leading-relaxed ${subText}`}>
                  Žádný zatím nemá screenshot ani konfluence. Doplň je, ať máš kompletní záznam pro review.
                </p>
              </div>
              <div className="flex flex-col gap-2 pt-1">
                <button
                  onClick={handleEnrichNow}
                  className="flex items-center justify-center gap-2 w-full px-5 py-3 rounded-xl text-xs font-black uppercase tracking-wider bg-emerald-600 hover:bg-emerald-500 text-white transition-all active:scale-95"
                >
                  <Sparkles size={14} /> Doplnit teď
                </button>
                <button
                  onClick={handleClose}
                  className={`w-full px-5 py-3 rounded-xl text-xs font-black uppercase tracking-wider ${subText} hover:bg-white/5`}
                >
                  Doplním později
                </button>
              </div>
            </div>
          ) : (
          <>
          <div className="p-5 space-y-4">
            {/* Výběr účtu */}
            <div>
              <label className={`text-[10px] font-black uppercase tracking-wider ${subText}`}>Účet</label>
              <select
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className={`mt-1.5 w-full rounded-xl border px-3 py-2.5 text-sm font-bold outline-none ${inputBg}`}
              >
                {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              {/* Cash History stav — aby user věděl, jestli má sazby nebo musí přidat CSV */}
              {(() => {
                const rates = loadFeeRates(accountId);
                if (rates) {
                  const symbols = Object.keys(rates);
                  return (
                    <div className="mt-2 flex items-center gap-1.5 text-[10px] font-bold text-emerald-500">
                      <CheckCircle2 size={11} />
                      <span>Cash History uloženo — sazby aktivní ({symbols.join(', ')})</span>
                    </div>
                  );
                }
                return (
                  <div className="mt-2 flex items-center gap-1.5 text-[10px] font-bold text-amber-500">
                    <AlertTriangle size={11} />
                    <span>Cash History ještě nenahrané · přidej ho pro přesný net P&L</span>
                  </div>
                );
              })()}
            </div>

            {/* Dropzone / soubor */}
            {!rawRows ? (
              <label className={`block cursor-pointer rounded-2xl border-2 border-dashed p-8 text-center transition-all ${
                isProcessing ? 'border-blue-500 bg-blue-500/5 cursor-wait' : 'border-white/15 hover:border-blue-500/50 hover:bg-white/5'
              }`}>
                <div className="flex flex-col items-center gap-3">
                  {isProcessing
                    ? <Loader2 className="w-7 h-7 text-blue-500 animate-spin" />
                    : <UploadCloud className="w-7 h-7 text-slate-400" />}
                  <div>
                    <p className={`text-sm font-bold ${text}`}>{isProcessing ? 'Zpracovávám…' : 'Vyber Tradovate export'}</p>
                    <p className={`text-[10px] ${subText}`}>Orders + Cash History naráz · .csv / .xlsx · samo rozpozná který je který</p>
                  </div>
                </div>
                <input ref={fileInputRef} type="file" accept=".csv,.xlsx" multiple onChange={handleFile} disabled={isProcessing} className="hidden" />
              </label>
            ) : (
              <div className={`flex items-center justify-between rounded-xl border px-3 py-2.5 ${inputBg}`}>
                <div className="flex items-center gap-2 min-w-0">
                  <FileText size={14} className="text-blue-500 shrink-0" />
                  <span className={`text-xs font-bold truncate ${text}`}>{fileName}</span>
                </div>
                <button onClick={reset} className={`text-[10px] font-black uppercase ${subText} hover:text-rose-500`}>Změnit</button>
              </div>
            )}

            {/* Volitelný Cash History — poplatky + přesný net P&L */}
            {rawRows && (
              cashRows ? (
                <div className={`flex items-center justify-between rounded-xl border px-3 py-2.5 ${isDark ? 'bg-emerald-500/5 border-emerald-500/30' : 'bg-emerald-50 border-emerald-200'}`}>
                  <div className="flex items-center gap-2 min-w-0">
                    <CheckCircle2 size={14} className="text-emerald-500 shrink-0" />
                    <span className={`text-xs font-bold truncate ${text}`}>{cashFileName}</span>
                    <span className="text-[10px] font-black uppercase text-emerald-500">net P&L</span>
                  </div>
                  <button onClick={() => { setCashRows(null); setCashFileName(''); if (cashInputRef.current) cashInputRef.current.value = ''; }} className={`text-[10px] font-black uppercase ${subText} hover:text-rose-500`}>Odebrat</button>
                </div>
              ) : (summary?.feesEstimated && !showCashUpload) ? (
                <div className={`flex items-center justify-between rounded-xl border px-3 py-2.5 ${isDark ? 'bg-emerald-500/5 border-emerald-500/30' : 'bg-emerald-50 border-emerald-200'}`}>
                  <div className="flex items-center gap-2 min-w-0">
                    <CheckCircle2 size={14} className="text-emerald-500 shrink-0" />
                    <span className={`text-xs font-bold ${text}`}>Sazby účtu uložené</span>
                    <span className="text-[10px] font-black uppercase text-emerald-500">net z paměti · Cash History netřeba</span>
                  </div>
                  <button onClick={() => setShowCashUpload(true)} className={`text-[10px] font-black uppercase ${subText} hover:text-emerald-500`}>Obnovit</button>
                </div>
              ) : (
                <label className={`block cursor-pointer rounded-xl border border-dashed px-3 py-2.5 text-center transition-all ${isDark ? 'border-white/15 hover:border-emerald-500/50 hover:bg-emerald-500/5' : 'border-slate-300 hover:border-emerald-400 hover:bg-emerald-50'}`}>
                  <div className="flex items-center justify-center gap-2">
                    <UploadCloud size={13} className={subText} />
                    <span className={`text-[11px] font-bold ${subText}`}>+ Cash History <span className="opacity-70">{summary?.feesEstimated ? '(obnovit sazby účtu)' : '(volitelně — poplatky a přesný net P&L)'}</span></span>
                  </div>
                  <input ref={cashInputRef} type="file" accept=".csv,.xlsx" onChange={handleCashFile} className="hidden" />
                </label>
              )
            )}
            {cashError && (
              <div className="flex items-start gap-2 rounded-xl bg-amber-500/10 border border-amber-500/30 p-2.5">
                <AlertTriangle size={13} className="text-amber-500 shrink-0 mt-0.5" />
                <p className="text-[11px] text-amber-400">{cashError}</p>
              </div>
            )}

            {/* Error */}
            {parseError && (
              <div className="flex items-start gap-2 rounded-xl bg-rose-500/10 border border-rose-500/30 p-3">
                <AlertTriangle size={14} className="text-rose-500 shrink-0 mt-0.5" />
                <p className="text-xs text-rose-400">{parseError}</p>
              </div>
            )}

            {/* Náhled výsledku */}
            {summary && (
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-2">
                  <div className={`rounded-xl border p-3 ${isDark ? 'bg-slate-800/50 border-white/10' : 'bg-slate-50 border-slate-200'}`}>
                    <p className={`text-[9px] font-black uppercase ${subText}`}>Obchodů</p>
                    <p className={`text-lg font-black ${text}`}>{newTrades.length}</p>
                  </div>
                  <div className={`rounded-xl border p-3 ${isDark ? 'bg-slate-800/50 border-white/10' : 'bg-slate-50 border-slate-200'}`}>
                    <p className={`text-[9px] font-black uppercase ${subText}`}>P&L {summary.feesApplied ? '(net)' : '(gross)'}</p>
                    <p className={`text-lg font-black flex items-center gap-1 ${pnlPositive ? 'text-emerald-500' : 'text-rose-500'}`}>
                      {pnlPositive ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                      {fmtUsd(summary.totalPnL)}
                    </p>
                  </div>
                  <div className={`rounded-xl border p-3 ${isDark ? 'bg-slate-800/50 border-white/10' : 'bg-slate-50 border-slate-200'}`}>
                    <p className={`text-[9px] font-black uppercase ${subText}`}>Fills</p>
                    <p className={`text-lg font-black ${text}`}>{summary.totalFills}</p>
                  </div>
                </div>

                {/* Info řádky */}
                <div className="space-y-1.5 text-[11px]">
                  {summary.withSLTP > 0 && (
                    <p className="text-emerald-500">✓ {summary.withSLTP} z {newTrades.length} obchodů má vytažený SL/TP z bracketů.</p>
                  )}
                  {summary.feesApplied ? (
                    summary.feesEstimated ? (
                      <p className="text-emerald-500">✓ Poplatky dopočítané z uložených sazeb účtu ({fmtUsd(summary.totalFees)}) — net P&L. Cash History tentokrát netřeba.</p>
                    ) : (
                      <p className="text-emerald-500">✓ Poplatky z Cash History ({fmtUsd(summary.totalFees)}) — net P&L sedí na cent. Sazby uloženy pro příští importy.</p>
                    )
                  ) : (
                    <p className={subText}>P&L je gross (bez poplatků). Přidej Cash History (stačí jednou — sazby si pak zapamatuju).</p>
                  )}
                  {summary.autoLiqCount > 0 && (
                    <p className="text-rose-400">⚠ {summary.autoLiqCount}× nucená likvidace (AutoLiq) — označeno tagem.</p>
                  )}
                  {dupCount > 0 && (
                    <p className={subText}>↺ {dupCount} obchodů už máš naimportováno — přeskočeno (dedup).</p>
                  )}
                  {summary.openPositions > 0 && (
                    <p className="text-amber-500">⚠ {summary.openPositions} kontraktů zůstalo neuzavřených (chybí protistrana ve fillech) — nezahrnuto.</p>
                  )}
                  {summary.unknownContracts.length > 0 && (
                    <p className="text-amber-500">⚠ Neznámé kontrakty: {summary.unknownContracts.join(', ')} — P&L orientační, doplň point value.</p>
                  )}
                  {summary.skippedFills > 0 && (
                    <div>
                      <button
                        onClick={() => setShowSkipped(v => !v)}
                        className={`flex items-center gap-1 ${subText} hover:underline`}
                      >
                        <ChevronDown size={12} className={`transition-transform ${showSkipped ? 'rotate-180' : ''}`} />
                        · {summary.skippedFills} řádků přeskočeno (cancel/reject/neúplné) — zobrazit
                      </button>
                      {showSkipped && (
                        <div className={`mt-1.5 rounded-lg border overflow-hidden ${isDark ? 'border-white/10' : 'border-slate-200'}`}>
                          <div className={`max-h-44 overflow-y-auto divide-y ${isDark ? 'divide-white/5' : 'divide-slate-100'}`}>
                            {summary.skippedRows.map((s, i) => (
                              <div key={i} className={`flex items-center gap-2 px-2.5 py-1.5 ${isDark ? 'bg-slate-800/40' : 'bg-slate-50'}`}>
                                <span className={`font-bold ${text} w-16 truncate`}>{s.contract}</span>
                                <span className={`${subText} w-10`}>{s.side}</span>
                                <span className={`${subText} w-8 text-right`}>{s.qty}</span>
                                <span className="text-amber-500 flex-1 truncate" title={`${s.status} · ${s.time}`}>{s.reason}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 p-5 border-t border-white/10">
            <button onClick={handleClose} className={`px-4 py-2.5 rounded-xl text-xs font-black uppercase tracking-wider ${subText} hover:bg-white/5`}>
              Zrušit
            </button>
            <button
              onClick={handleConfirm}
              disabled={newTrades.length === 0}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-black uppercase tracking-wider bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-all active:scale-95"
            >
              <CheckCircle2 size={14} />
              Importovat {newTrades.length > 0 ? `(${newTrades.length})` : ''}
            </button>
          </div>
          </>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};

export default TradovateImportModal;
