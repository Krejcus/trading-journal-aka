
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  X, Save, Tag, Wallet, Target,
  Brain, Zap, Layers, CheckCircle2,
  ChevronDown, ChevronUp, Cpu, Activity,
  Timer, BarChart3, ArrowUpRight, ArrowDownRight,
  Hash, ImageIcon, Maximize2, Monitor, Layout,
  AlertOctagon, AlertTriangle, Plus, Trash2, Clock, DollarSign, Check
} from 'lucide-react';
import ConfirmationModal from './ConfirmationModal';
import { Trade, Account, CustomEmotion } from '../types';

interface ManualTradeFormProps {
  onAdd: (trades: Trade | Trade[]) => void;
  onClose: () => void;
  theme: 'dark' | 'light' | 'oled';
  accounts: Account[];
  activeAccountId: string;
  availableEmotions: CustomEmotion[];
  availableMistakes: string[];
  availableHtfOptions: string[];
  availableLtfOptions: string[];
  instrumentFees?: Record<string, number>;
  viewMode?: 'individual' | 'combined';
}

const INSTRUMENTS = [
  { id: 'NQ', name: 'Nasdaq 100', multiplier: 20, icon: <Cpu size={14} />, color: 'text-blue-400' },
  { id: 'MNQ', name: 'Micro Nasdaq', multiplier: 2, icon: <Cpu size={14} />, color: 'text-blue-400' },
  // { id: 'ES', name: 'S&P 500', multiplier: 50, icon: <Activity size={14} />, color: 'text-emerald-400' },
  // { id: 'MES', name: 'Micro S&P', multiplier: 5, icon: <Activity size={14} />, color: 'text-emerald-400' },
  // { id: 'GC', name: 'Zlato', multiplier: 100, icon: <Target size={14} />, color: 'text-yellow-400' },
  // { id: 'CL', name: 'Ropa (WTI)', multiplier: 1000, icon: <Zap size={14} />, color: 'text-orange-400' },
  // { id: 'CUSTOM', name: 'Vlastní', multiplier: 1, icon: <Layers size={14} />, color: 'text-slate-400' },
];

const ManualTradeForm: React.FC<ManualTradeFormProps> = ({
  onAdd, onClose, theme, accounts, activeAccountId,
  availableEmotions, availableMistakes, availableHtfOptions, availableLtfOptions,
  instrumentFees, viewMode = 'individual'
}) => {
  const [isAccountOpen, setIsAccountOpen] = useState(false);
  const [isInstrumentOpen, setIsInstrumentOpen] = useState(false);
  const [expandedSection, setExpandedSection] = useState<'emotions' | 'htf' | 'ltf' | 'mistakes' | null>('emotions');
  const [isZoomed, setIsZoomed] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isDeleteDraftModalOpen, setIsDeleteDraftModalOpen] = useState(false);
  const isDark = theme !== 'light';

  const getLocalISOString = (date?: Date) => {
    const d = date || new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  };

  const [formData, setFormData] = useState({
    accountIds: [activeAccountId],
    instrument: 'MNQ',
    customMultiplier: '1',
    entryDate: getLocalISOString(),
    exitDate: getLocalISOString(new Date(Date.now() + 15 * 60000)),
    entryPrice: '',
    exitPrice: '',
    stopLoss: '',
    takeProfit: '',
    positionSize: '1',
    pnl: '',
    notes: '',
    htfConfluence: [] as string[],
    ltfConfluence: [] as string[],
    mistakes: [] as string[],
    screenshots: [] as string[],
    emotions: [] as string[],
    planAdherence: 'Yes' as 'Yes' | 'No' | 'Partial',
    executionStatus: 'Valid' as 'Valid' | 'Invalid' | 'Missed'
  });

  const handlePaste = useCallback((e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (items) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          const blob = items[i].getAsFile();
          if (blob) {
            const reader = new FileReader();
            reader.onloadend = () => {
              const base64 = reader.result as string;
              setFormData(prev => ({
                ...prev,
                screenshots: [...prev.screenshots, base64]
              }));
            };
            reader.readAsDataURL(blob);
          }
        }
      }
    }
  }, []);

  useEffect(() => {
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [handlePaste]);

  // Save draft whenever formData changes
  useEffect(() => {
    localStorage.setItem('alphatrade_trade_draft', JSON.stringify(formData));
  }, [formData]);

  const calculations = useMemo(() => {
    const entry = parseFloat(formData.entryPrice);
    const exit = parseFloat(formData.exitPrice);
    const sl = parseFloat(formData.stopLoss);
    const size = parseFloat(formData.positionSize);
    const instDef = INSTRUMENTS.find(i => i.id === formData.instrument);
    const multiplier = instDef?.id === 'CUSTOM' ? parseFloat(formData.customMultiplier) || 1 : instDef?.multiplier || 1;

    // Get fees from the FIRST selected account
    const firstAcc = accounts.find(a => a.id === formData.accountIds[0]);
    const feesToUse = firstAcc?.instrumentFees || instrumentFees || {};
    const feePerUnit = feesToUse[formData.instrument] || 0;

    let direction: 'Long' | 'Short' = 'Long';
    if (!isNaN(entry) && !isNaN(sl)) direction = sl < entry ? 'Long' : 'Short';

    let pnl = 0; let riskVal = 0; let rr = 0; let totalFees = 0;

    if (!isNaN(entry) && !isNaN(exit) && !isNaN(size)) {
      totalFees = feePerUnit * size;
      const movementPnL = (direction === 'Long' ? (exit - entry) : (entry - exit)) * size * multiplier;
      pnl = movementPnL - totalFees; // Subtract fees from raw PnL
    }

    if (!isNaN(entry) && !isNaN(sl) && !isNaN(size)) {
      riskVal = Math.abs(entry - sl) * size * multiplier;
      if (riskVal !== 0) rr = Math.abs(pnl) / riskVal;
    }

    const durationMinutes = (new Date(formData.exitDate).getTime() - new Date(formData.entryDate).getTime()) / 60000;
    let session = 'Asie';
    const hour = new Date(formData.entryDate).getHours();
    if (hour >= 8 && hour < 14) session = 'Londýn';
    else if (hour >= 14 && hour < 21) session = 'New York';

    return {
      pnl: pnl || 0,
      risk: riskVal || 0,
      rr: isFinite(rr) && rr > 0 ? rr.toFixed(2) : '0.00',
      durationMinutes: Math.max(0, durationMinutes),
      session,
      direction,
      totalFees
    };
  }, [formData, instrumentFees]);

  // ... (Zbytek metod toggleConfluence, handleRemoveScreenshot atd. zůstává stejný) ...
  const toggleConfluence = (type: 'htf' | 'ltf' | 'mistake', item: string) => {
    let field: 'htfConfluence' | 'ltfConfluence' | 'mistakes';
    if (type === 'htf') field = 'htfConfluence';
    else if (type === 'ltf') field = 'ltfConfluence';
    else field = 'mistakes';

    setFormData(prev => ({
      ...prev,
      [field]: prev[field].includes(item)
        ? prev[field].filter(i => i !== item)
        : [...prev[field], item]
    }));
  };

  const handleRemoveScreenshot = (index: number) => {
    setFormData(prev => ({
      ...prev,
      screenshots: prev.screenshots.filter((_, i) => i !== index)
    }));
  };

  const handleAddScreenshot = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setFormData(prev => ({ ...prev, screenshots: [...prev.screenshots, reader.result as string] }));
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // Weekend validation
    const entryDate = new Date(formData.entryDate);
    const exitDate = new Date(formData.exitDate);

    const isEntryWeekend = entryDate.getDay() === 0 || entryDate.getDay() === 6;
    const isExitWeekend = exitDate.getDay() === 0 || exitDate.getDay() === 6;

    if (isEntryWeekend || isExitWeekend) {
      setValidationError("Burza je o víkendu zavřená. Vyberte prosím pracovní den.");
      setTimeout(() => setValidationError(null), 5000);
      return;
    }

    const pnlNum = parseFloat(formData.pnl || calculations.pnl.toString());
    const groupId = formData.accountIds.length > 1 ? 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    }) : undefined;

    const masterAccount = accounts.find(a => formData.accountIds.includes(a.id) && !a.parentAccountId && accounts.some(other => other.parentAccountId === a.id));

    // Use proper UUIDs to prevent sync issues
    const generateUUID = () => {
      try {
        return crypto.randomUUID();
      } catch (e) {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
          var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
          return v.toString(16);
        });
      }
    };

    const masterTradeId = masterAccount ? generateUUID() : undefined;

    localStorage.removeItem('alphatrade_trade_draft');

    // Create new trade(s):
    const tradesToCreate: Trade[] = formData.accountIds.map(accId => {
      const acc = accounts.find(a => a.id === accId);
      const isThisMaster = accId === masterAccount?.id;
      const isChildOfMaster = acc?.parentAccountId && acc.parentAccountId === masterAccount?.id;

      return {
        id: (isThisMaster && masterTradeId ? masterTradeId : generateUUID()),
        accountId: accId,
        groupId: groupId,
        isMaster: isThisMaster,
        masterTradeId: isChildOfMaster ? masterTradeId : undefined,
        instrument: formData.instrument,
        date: new Date(formData.exitDate).toISOString(),
        timestamp: new Date(formData.exitDate).getTime(),
        signal: 'Manuální obchod',
        direction: calculations.direction,
        pnl: pnlNum,
        riskAmount: calculations.risk,
        targetAmount: Math.abs(pnlNum),
        riskPercent: 0,
        runUp: 0,
        drawdown: 0,
        durationMinutes: calculations.durationMinutes,
        duration: `${Math.floor(calculations.durationMinutes)}m`,
        notes: formData.notes,
        htfConfluence: formData.htfConfluence,
        ltfConfluence: formData.ltfConfluence,
        mistakes: formData.mistakes,
        screenshot: formData.screenshots[0],
        screenshots: formData.screenshots,
        emotions: formData.emotions,
        planAdherence: formData.executionStatus === 'Valid' ? 'Yes' : 'No',
        isValid: formData.executionStatus === 'Valid',
        executionStatus: formData.executionStatus,
        session: calculations.session,
        entryPrice: parseFloat(formData.entryPrice) || 0,
        exitPrice: parseFloat(formData.exitPrice) || 0,
        stopLoss: parseFloat(formData.stopLoss) || 0,
        takeProfit: parseFloat(formData.takeProfit) || 0,
        positionSize: parseFloat(formData.positionSize) || 1,
        phase: acc?.phase || 'Challenge'
      };
    });

    onAdd(tradesToCreate);
  };

  const inputContainerClass = `relative h-[42px] rounded-xl border transition-all flex items-center overflow-hidden ${theme !== 'light' ? 'bg-[var(--bg-input)] border-[var(--border-subtle)] focus-within:border-blue-500/50' : 'bg-[var(--bg-input)] border-[var(--border-subtle)] focus-within:border-[var(--border-active)]'}`;
  const inlineLabelClass = `px-3 text-[9px] font-black uppercase text-[var(--text-muted)] whitespace-nowrap border-r border-[var(--border-subtle)] h-full flex items-center bg-[var(--bg-page)]/50 min-w-[85px]`;
  const inputClass = `w-full px-3 py-2 bg-transparent text-sm font-black tabular-nums outline-none text-[var(--text-primary)] placeholder-[var(--text-secondary)]`;
  const pilarHeaderClass = "text-[10px] font-black uppercase tracking-[0.2em] text-blue-500 mb-4 flex items-center gap-2";

  const currentInst = INSTRUMENTS.find(i => i.id === formData.instrument);
  const activeAccounts = useMemo(() => accounts.filter(a => a.status === 'Active'), [accounts]);

  const selectedAccCount = formData.accountIds.length;
  const firstSelectedAcc = accounts.find(a => a.id === formData.accountIds[0]);

  return (
    <>
      <div className="fixed inset-0 z-[100] flex items-center justify-center p-2 md:p-4 bg-[var(--bg-page)]/60 backdrop-blur-2xl animate-in fade-in duration-500">
        <div className={`w-full max-w-[1400px] max-h-[96vh] rounded-[32px] md:rounded-[40px] shadow-[0_32px_128px_rgba(0,0,0,0.8)] border flex flex-col overflow-hidden animate-in zoom-in-95 duration-500 relative z-10 ${theme !== 'light' ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-[var(--bg-card)] border-[var(--border-subtle)] shadow-2xl'}`}>
          <div className={`px-5 py-4 md:px-8 md:py-5 border-b flex justify-between items-center bg-[var(--bg-page)]/50 border-[var(--border-subtle)] backdrop-blur-md shrink-0`}>
            <div className="flex items-center gap-3 md:gap-4">
              <div className={`p-2.5 rounded-xl bg-gradient-to-br from-blue-500 to-blue-700 shadow-lg shadow-blue-500/20`}><Plus size={18} className="text-white" /></div>
              <div>
                <h2 className={`text-sm md:text-lg font-black tracking-tighter uppercase text-[var(--text-primary)]`}>NOVÝ OBCHOD</h2>
              </div>
              {localStorage.getItem('alphatrade_trade_draft') && (
                <button
                  type="button"
                  onClick={() => setIsDeleteDraftModalOpen(true)}
                  className="ml-4 px-3 py-1.5 rounded-lg bg-rose-500/10 text-rose-500 text-[9px] font-black uppercase hover:bg-rose-500 hover:text-white transition-all border border-rose-500/20"
                >
                  Smazat koncept
                </button>
              )}
            </div>
            <button type="button" onClick={onClose} className="p-2 hover:bg-white/10 rounded-full transition-all active:scale-90"><X size={20} className="text-slate-500" /></button>
          </div>

          <div className="flex-1 overflow-y-auto custom-scrollbar p-5 md:p-8 lg:p-10 bg-gradient-to-b from-transparent to-[var(--bg-page)]/40">
            <div className={`flex flex-col lg:flex-row gap-6 mb-8 justify-between items-start lg:items-center p-4 rounded-3xl border ${theme !== 'light' ? 'bg-[var(--bg-page)]/60 border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-200'}`}>
              <div className="flex flex-wrap gap-4 md:gap-6 w-full relative">
                <div className="flex flex-col"><span className="text-[8px] font-black text-slate-500 uppercase">{formData.executionStatus === 'Missed' ? 'Ušlý zisk' : 'Výsledek (Net)'}</span><span className={`text-xl font-mono font-black ${calculations.pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'} ${formData.executionStatus === 'Missed' ? 'opacity-50' : ''}`}>${calculations.pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span></div>
                <div className="hidden md:block w-px h-8 bg-white/5"></div>
                <div className="flex flex-col"><span className="text-[8px] font-black text-slate-500 uppercase">Fees</span><span className="text-sm font-mono font-black text-rose-400">-${calculations.totalFees.toFixed(2)}</span></div>
                <div className="hidden md:block w-px h-8 bg-white/5"></div>
                <div className="flex flex-col"><span className="text-[8px] font-black text-slate-500 uppercase">R:R Ratio</span><span className="text-sm font-mono font-black text-blue-400">{calculations.rr} R</span></div>
                <div className="hidden md:block w-px h-8 bg-white/5"></div>
                <div className="flex flex-col"><span className="text-[8px] font-black text-slate-500 uppercase">Seance</span><span className={`text-[10px] font-black uppercase ${isDark ? 'text-white' : 'text-slate-900'}`}>{calculations.session}</span></div>
                <div className="ml-auto flex items-center">
                  <div className={`px-2 py-1 rounded text-[9px] font-black uppercase flex items-center gap-1 ${calculations.direction === 'Long' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-orange-500/10 text-orange-500'}`}>
                    {calculations.direction === 'Long' ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />} {calculations.direction}
                  </div>
                </div>

                {validationError && (
                  <div className="absolute inset-0 bg-rose-600 rounded-2xl flex items-center justify-center gap-3 px-6 animate-in slide-in-from-top-4 duration-300 z-50">
                    <AlertTriangle size={20} className="text-white animate-pulse" />
                    <span className="text-xs font-black text-white uppercase tracking-widest">{validationError}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Zbytek formuláře zůstává stejný */}
            <form onSubmit={handleSubmit} className="space-y-8">
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6 md:gap-8 items-start">
                <div className="space-y-4">
                  <h3 className={pilarHeaderClass}><Zap size={12} /> 01 Genesis</h3>
                  <div className="relative group">
                    <div className={inputContainerClass}>
                      <div className={inlineLabelClass}><Wallet size={10} className="mr-1" /> Terminal</div>
                      <button
                        type="button"
                        onClick={() => setIsAccountOpen(!isAccountOpen)}
                        className={`w-full h-full flex items-center justify-between px-3 text-xs font-black hover:bg-white/5 ${isDark ? 'text-white' : 'text-slate-900'}`}
                      >
                        {selectedAccCount === 0 ? 'Vyberte účet' : selectedAccCount === 1 ? firstSelectedAcc?.name : `Hromadné (${selectedAccCount})`} <ChevronDown size={12} className="text-slate-600" />
                      </button>
                    </div>
                    {isAccountOpen && (
                      <div className={`absolute top-full left-0 right-0 mt-2 z-[200] rounded-xl border shadow-2xl overflow-hidden animate-in fade-in duration-200 ${theme !== 'light' ? 'bg-[var(--bg-card)]/95 border-[var(--border-subtle)] backdrop-blur-xl' : 'bg-white border-slate-200'}`}>
                        <button
                          type="button"
                          onClick={() => {
                            const allIds = activeAccounts.map(a => a.id);
                            setFormData(prev => ({ ...prev, accountIds: prev.accountIds.length === allIds.length ? [] : allIds }));
                          }}
                          className={`w-full px-4 py-2 text-[9px] font-black text-left hover:bg-blue-600/20 text-blue-500 uppercase border-b ${theme === 'light' ? 'border-slate-100' : 'border-white/5'}`}
                        >
                          {formData.accountIds.length === accounts.length ? 'Zrušit vše' : 'Vybrat vše'}
                        </button>
                        {activeAccounts.map(acc => (
                          <button
                            key={acc.id}
                            type="button"
                            onClick={() => {
                              const isAdding = !formData.accountIds.includes(acc.id);
                              let newSelection = isAdding
                                ? [...formData.accountIds, acc.id]
                                : formData.accountIds.filter(id => id !== acc.id);

                              // Special Master-Copy logic
                              if (isAdding) {
                                // If adding a master, add all its copies
                                const copies = accounts.filter(a => a.parentAccountId === acc.id).map(a => a.id);
                                if (copies.length > 0) {
                                  newSelection = Array.from(new Set([...newSelection, ...copies]));
                                }
                              } else {
                                // If removing a master, remove all its copies
                                const copies = accounts.filter(a => a.parentAccountId === acc.id).map(a => a.id);
                                if (copies.length > 0) {
                                  newSelection = newSelection.filter(id => !copies.includes(id));
                                }
                              }

                              setFormData(p => ({
                                ...p,
                                accountIds: newSelection
                              }));
                            }}
                            className={`w-full px-4 py-3 text-[10px] font-black text-left hover:bg-blue-600 ${theme === 'light' ? 'text-slate-600' : 'text-slate-400'} hover:text-white uppercase border-b ${theme === 'light' ? 'border-slate-100' : 'border-white/5'} last:border-0 flex items-center justify-between`}
                          >
                            <div className="flex items-center gap-2">
                              {acc.name}
                              {/* Master/Copy Indicators */}
                              {!acc.parentAccountId && accounts.some(other => other.parentAccountId === acc.id) && (
                                <span className="px-1.5 py-0.5 bg-blue-600/20 text-blue-400 rounded text-[7px] font-black tracking-widest border border-blue-500/30">MASTER</span>
                              )}
                              {acc.parentAccountId && (
                                <span className="px-1.5 py-0.5 bg-purple-600/20 text-purple-400 rounded text-[7px] font-black tracking-widest border border-purple-500/30">COPY</span>
                              )}
                            </div>
                            {formData.accountIds.includes(acc.id) && <Check size={12} className="text-emerald-500" />}
                          </button>
                        ))}
                      </div>
                    )}
                    {/* Copy Info Summary */}
                    {formData.accountIds.length > 1 && (
                      <div className="mt-2 px-3 py-1.5 bg-blue-600/10 border border-blue-500/20 rounded-xl flex items-center gap-2">
                        <Zap size={10} className="text-blue-500" />
                        <span className="text-[9px] font-black uppercase text-blue-400 tracking-widest">
                          {accounts.find(a => formData.accountIds.includes(a.id) && !a.parentAccountId && accounts.some(other => other.parentAccountId === a.id)) ? 'Master + ' : ''}
                          {formData.accountIds.length - (accounts.find(a => formData.accountIds.includes(a.id) && !a.parentAccountId && accounts.some(other => other.parentAccountId === a.id)) ? 1 : 0)} kopie zvoleny
                        </span>
                      </div>
                    )}
                  </div>
                  <div className={inputContainerClass}><div className={inlineLabelClass}>Vstup</div><input type="number" step="any" value={formData.entryPrice} onChange={e => setFormData({ ...formData, entryPrice: e.target.value })} className={inputClass} placeholder="0.00" /></div>
                  <div className={inputContainerClass}><div className={inlineLabelClass}>Stop Loss</div><input type="number" step="any" value={formData.stopLoss} onChange={e => setFormData({ ...formData, stopLoss: e.target.value })} className={`${inputClass} text-rose-500`} placeholder="0.00" /></div>
                  <div className={inputContainerClass}><div className={inlineLabelClass}>Start</div><input type="datetime-local" value={formData.entryDate} onChange={e => setFormData({ ...formData, entryDate: e.target.value })} className={`${inputClass} text-[10px]`} /></div>
                  <div className={inputContainerClass}><div className={inlineLabelClass}><Hash size={10} className="mr-1" /> Objem</div><input type="number" step="any" value={formData.positionSize} onChange={e => setFormData({ ...formData, positionSize: e.target.value })} className={inputClass} placeholder="1.0" /></div>
                </div>

                <div className="space-y-4">
                  <h3 className={pilarHeaderClass}><Target size={12} /> 02 Finalizace</h3>
                  <div className="relative group">
                    <div className={inputContainerClass}>
                      <div className={inlineLabelClass}><Layers size={10} className="mr-1" /> Aktivum</div>
                      <button type="button" onClick={() => setIsInstrumentOpen(!isInstrumentOpen)} className={`w-full h-full flex items-center justify-between px-3 text-xs font-black hover:bg-white/5 ${isDark ? 'text-white' : 'text-slate-900'}`}>
                        {currentInst?.name} <ChevronDown size={12} className="text-slate-600" />
                      </button>
                    </div>
                    {isInstrumentOpen && (<div className={`absolute top-full left-0 right-0 mt-2 z-[200] rounded-xl border shadow-2xl overflow-hidden animate-in fade-in duration-200 ${theme !== 'light' ? 'bg-[var(--bg-card)]/95 border-[var(--border-subtle)] backdrop-blur-xl' : 'bg-white border-slate-200'}`}>{INSTRUMENTS.map(i => (<button key={i.id} type="button" onClick={() => { setFormData({ ...formData, instrument: i.id }); setIsInstrumentOpen(false); }} className={`w-full px-4 py-3 text-[10px] font-black text-left hover:bg-blue-600 ${theme === 'light' ? 'text-slate-600' : 'text-slate-400'} hover:text-white uppercase border-b ${theme === 'light' ? 'border-slate-100' : 'border-white/5'} last:border-0`}>{i.name}</button>))}</div>)}
                  </div>
                  <div className={inputContainerClass}><div className={inlineLabelClass}>Výstup</div><input type="number" step="any" value={formData.exitPrice} onChange={e => setFormData({ ...formData, exitPrice: e.target.value })} className={inputClass} placeholder="0.00" /></div>
                  <div className={inputContainerClass}><div className={inlineLabelClass}>Cíl (TP)</div><input type="number" step="any" value={formData.takeProfit} onChange={e => setFormData({ ...formData, takeProfit: e.target.value })} className={`${inputClass} text-emerald-500`} placeholder="0.00" /></div>
                  <div className={inputContainerClass}><div className={inlineLabelClass}>Konec</div><input type="datetime-local" value={formData.exitDate} onChange={e => setFormData({ ...formData, exitDate: e.target.value })} className={`${inputClass} text-[10px]`} /></div>

                  <div className="space-y-1.5">
                    <label className="text-[9px] font-black uppercase text-slate-500 tracking-widest ml-1">Execution Status</label>
                    <div className={`p-1 rounded-xl border flex relative overflow-hidden transition-all duration-300 ${formData.executionStatus === 'Valid' ? 'bg-emerald-500/10 border-emerald-500/20' : formData.executionStatus === 'Invalid' ? 'bg-rose-500/10 border-rose-500/20' : 'bg-blue-500/10 border-blue-500/20'}`}>
                      <div className={`absolute top-1 bottom-1 w-[calc(33.33%-3px)] rounded-lg transition-all duration-500 z-0 ${formData.executionStatus === 'Valid' ? 'bg-emerald-600' : formData.executionStatus === 'Invalid' ? 'bg-rose-600' : 'bg-blue-600'} shadow-lg ${formData.executionStatus === 'Valid' ? 'left-1' : formData.executionStatus === 'Invalid' ? 'left-[calc(33.33%+1px)]' : 'left-[calc(66.66%+1px)]'}`}></div>
                      <button type="button" onClick={() => setFormData({ ...formData, executionStatus: 'Valid' })} className={`flex-1 py-2 flex items-center justify-center gap-1.5 text-[8px] font-black uppercase relative z-10 transition-colors ${formData.executionStatus === 'Valid' ? 'text-white' : 'text-slate-600'}`}><CheckCircle2 size={10} /> Validní</button>
                      <button type="button" onClick={() => setFormData({ ...formData, executionStatus: 'Invalid' })} className={`flex-1 py-2 flex items-center justify-center gap-1.5 text-[8px] font-black uppercase relative z-10 transition-colors ${formData.executionStatus === 'Invalid' ? 'text-white' : 'text-slate-600'}`}><AlertOctagon size={10} /> Nevalidní</button>
                      <button type="button" onClick={() => setFormData({ ...formData, executionStatus: 'Missed' })} className={`flex-1 py-2 flex items-center justify-center gap-1.5 text-[8px] font-black uppercase relative z-10 transition-colors ${formData.executionStatus === 'Missed' ? 'text-white' : 'text-slate-600'}`}><Clock size={10} /> Missed</button>
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                  <h3 className={pilarHeaderClass}><Brain size={12} /> 03 Tactical Engine</h3>
                  <div className="space-y-2">
                    <div className={`rounded-2xl border overflow-hidden ${isDark ? 'border-white/5 bg-white/5' : 'border-slate-200 bg-slate-50'}`}>
                      <button type="button" onClick={() => setExpandedSection(expandedSection === 'emotions' ? null : 'emotions')} className={`w-full px-4 py-3 flex items-center justify-between text-[10px] font-black uppercase tracking-widest ${isDark ? 'bg-white/5' : 'bg-slate-100/50'}`}><span className="flex items-center gap-2"><Brain size={12} className="text-purple-500" /> Emoce</span>{expandedSection === 'emotions' ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>
                      {expandedSection === 'emotions' && (<div className="p-3 grid grid-cols-2 gap-2 animate-in slide-in-from-top-2 duration-200">{availableEmotions.map(emo => (<button key={emo.id} type="button" onClick={() => { setFormData(p => ({ ...p, emotions: p.emotions.includes(emo.id) ? p.emotions.filter(e => e !== emo.id) : [...p.emotions, emo.id] })) }} className={`py-2 px-2 rounded-lg border text-[9px] font-black uppercase transition-all ${formData.emotions.includes(emo.id) ? 'bg-purple-600 text-white border-purple-500' : (isDark ? 'bg-slate-950/50 text-slate-500 border-slate-800' : 'bg-white text-slate-400 border-slate-200')}`}>{emo.label}</button>))}</div>)}
                    </div>
                    <div className={`rounded-2xl border overflow-hidden ${isDark ? 'border-white/5 bg-white/5' : 'border-slate-200 bg-slate-50'}`}>
                      <button type="button" onClick={() => setExpandedSection(expandedSection === 'htf' ? null : 'htf')} className={`w-full px-4 py-3 flex items-center justify-between text-[10px] font-black uppercase tracking-widest ${isDark ? 'bg-white/5' : 'bg-slate-100/50'}`}><span className="flex items-center gap-2"><Monitor size={12} className="text-blue-500" /> HTF Kontext</span>{expandedSection === 'htf' ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>
                      {expandedSection === 'htf' && (<div className="p-3 grid grid-cols-2 gap-2 animate-in slide-in-from-top-2 duration-200">{availableHtfOptions.map(opt => (<button key={opt} type="button" onClick={() => toggleConfluence('htf', opt)} className={`py-2 px-2 rounded-lg border text-[8px] font-black uppercase transition-all ${formData.htfConfluence.includes(opt) ? 'bg-blue-600 text-white border-blue-500' : (isDark ? 'bg-slate-950/50 text-slate-500 border-slate-800' : 'bg-white text-slate-400 border-slate-200')}`}>{opt}</button>))}</div>)}
                    </div>
                    <div className={`rounded-2xl border overflow-hidden ${isDark ? 'border-white/5 bg-white/5' : 'border-slate-200 bg-slate-50'}`}>
                      <button type="button" onClick={() => setExpandedSection(expandedSection === 'ltf' ? null : 'ltf')} className={`w-full px-4 py-3 flex items-center justify-between text-[10px] font-black uppercase tracking-widest ${isDark ? 'bg-white/5' : 'bg-slate-100/50'}`}><span className="flex items-center gap-2"><Zap size={12} className="text-amber-500" /> LTF Trigger</span>{expandedSection === 'ltf' ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>
                      {expandedSection === 'ltf' && (<div className="p-3 grid grid-cols-2 gap-2 animate-in slide-in-from-top-2 duration-200">{availableLtfOptions.map(opt => (<button key={opt} type="button" onClick={() => toggleConfluence('ltf', opt)} className={`py-2 px-2 rounded-lg border text-[8px] font-black uppercase transition-all ${formData.ltfConfluence.includes(opt) ? 'bg-amber-600 text-white border-amber-500' : (isDark ? 'bg-slate-950/50 text-slate-500 border-slate-800' : 'bg-white text-slate-400 border-slate-200')}`}>{opt}</button>))}</div>)}
                    </div>
                    <div className={`rounded-2xl border overflow-hidden ${isDark ? 'border-white/5 bg-white/5' : 'border-slate-200 bg-slate-50'}`}>
                      <button type="button" onClick={() => setExpandedSection(expandedSection === 'mistakes' ? null : 'mistakes')} className={`w-full px-4 py-3 flex items-center justify-between text-[10px] font-black uppercase tracking-widest ${isDark ? 'bg-white/5' : 'bg-slate-100/50'}`}><span className="flex items-center gap-2"><AlertOctagon size={12} className="text-rose-500" /> Chyby Exekuce</span>{expandedSection === 'mistakes' ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>
                      {expandedSection === 'mistakes' && (<div className="p-3 grid grid-cols-2 gap-2 animate-in slide-in-from-top-2 duration-200">{availableMistakes.map(opt => (<button key={opt} type="button" onClick={() => toggleConfluence('mistake', opt)} className={`py-2 px-2 rounded-lg border text-[8px] font-black uppercase transition-all ${formData.mistakes.includes(opt) ? 'bg-rose-600 text-white border-rose-500 shadow-lg shadow-rose-500/20' : (isDark ? 'bg-slate-950/50 text-slate-500 border-slate-800' : 'bg-white text-slate-400 border-slate-200')}`}>{opt}</button>))}</div>)}
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                  <h3 className={pilarHeaderClass}><ImageIcon size={12} /> 04 Evidence</h3>
                  {formData.screenshots.length > 0 ? (
                    <div className="grid grid-cols-2 gap-2">
                      {formData.screenshots.map((src, index) => (
                        <div key={index} className="relative group aspect-video rounded-xl border border-white/10 overflow-hidden cursor-pointer" onClick={() => setIsZoomed(src)}>
                          <img src={src} className="w-full h-full object-cover" />
                          <button type="button" onClick={(e) => { e.stopPropagation(); handleRemoveScreenshot(index); }} className="absolute top-1 right-1 p-1 bg-red-600 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity"><X size={12} /></button>
                        </div>
                      ))}
                      <label className="flex flex-col items-center justify-center aspect-video rounded-xl border-2 border-dashed border-white/10 hover:border-blue-500/50 hover:bg-white/5 cursor-pointer transition-all"><Plus size={20} className="text-slate-500" /><span className="text-[8px] font-black uppercase text-slate-500 mt-1">Add</span><input type="file" className="hidden" accept="image/*" onChange={handleAddScreenshot} /></label>
                    </div>
                  ) : (
                    <div className={`relative group rounded-2xl border-2 border-dashed h-[140px] overflow-hidden transition-all ${formData.screenshots.length > 0 ? 'border-blue-500/50 cursor-pointer' : 'border-white/10 hover:border-blue-500/50 bg-white/5'}`}><label className="flex flex-col items-center justify-center h-full cursor-pointer p-4 text-center"><ImageIcon size={24} className="text-slate-700 mb-1" /><span className="text-[9px] font-black uppercase text-slate-600 tracking-tighter">Vložit graf (CTRL+V)</span><input type="file" className="hidden" accept="image/*" onChange={handleAddScreenshot} /></label></div>
                  )}
                  <textarea value={formData.notes} onChange={e => setFormData({ ...formData, notes: e.target.value })} className={`w-full h-[120px] px-4 py-3 rounded-2xl border transition-all resize-none placeholder-slate-700 outline-none focus:border-blue-500/50 text-[11px] font-black ${isDark ? 'bg-white/5 border-white/5 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-700'}`} placeholder="Poznámky k chybám nebo mindsetu..." />
                </div>
              </div>
            </form>
          </div>

          <div className={`p-5 md:p-8 shrink-0 border-t flex flex-col sm:flex-row gap-3 md:gap-6 bg-[var(--bg-page)]/50 border-[var(--border-subtle)] backdrop-blur-xl`}>
            <button type="button" onClick={onClose} className="w-full sm:w-[180px] h-[52px] bg-white/5 text-slate-500 rounded-2xl font-black text-xs uppercase tracking-widest border border-white/5 hover:bg-white/10 transition-all">Zrušit</button>
            <button onClick={handleSubmit} type="button" className={`flex-1 h-[52px] rounded-2xl font-black text-xs uppercase tracking-widest shadow-2xl transition-all flex items-center justify-center gap-3 ${formData.executionStatus === 'Valid' ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-600/20' : formData.executionStatus === 'Invalid' ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-rose-600/20' : 'bg-blue-600 hover:bg-blue-500 text-white shadow-blue-600/20'}`}><Save size={18} /> ULOŽIT OBCHOD</button>
          </div>
        </div >
      </div >
      {isZoomed && (<div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/90 backdrop-blur-md p-4 animate-in fade-in duration-300" onClick={() => setIsZoomed(null)}><button className="absolute top-10 right-10 p-4 bg-white/10 hover:bg-white/20 rounded-full transition-all"><X size={32} className="text-white" /></button><img src={isZoomed} className="max-w-full max-h-full object-contain rounded-xl shadow-2xl" onClick={e => e.stopPropagation()} /></div>)}

      <ConfirmationModal
        isOpen={isDeleteDraftModalOpen}
        onClose={() => setIsDeleteDraftModalOpen(false)}
        onConfirm={() => {
          localStorage.removeItem('alphatrade_trade_draft');
          window.location.reload();
        }}
        title="Smazat koncept"
        message="Opravdu chcete smazat rozpracovaný koncept obchodu? Tato akce je nevratná."
        theme={theme}
      />
    </>
  );
};

export default ManualTradeForm;
