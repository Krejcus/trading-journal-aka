import React, { useMemo, useState } from 'react';
import { AlertTriangle, Check, Link2, Loader2, X } from 'lucide-react';
import {
  buildManualLinkOptions,
  normalizeSymbol,
  type ExecutionGroup,
  type ManualLinkOption,
} from '../services/importPairing';
import type { ImportAccountInfo, PairingRunResult } from '../services/importService';

const fmtMoney = (value: number) => `${value >= 0 ? '+' : ''}$${Math.round(value).toLocaleString('en-US')}`;
const tradeTime = (trade: ManualLinkOption['representative']) => trade.entryTime || trade.timestamp;
const fmtDateTime = (timestamp: number) => new Date(timestamp).toLocaleString('cs-CZ', {
  day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit',
});

interface ImportManualLinkModalProps {
  group: ExecutionGroup;
  result: PairingRunResult;
  isDark: boolean;
  onClose: () => void;
  onConfirm: (option: ManualLinkOption) => Promise<void>;
}

export const ImportManualLinkModal: React.FC<ImportManualLinkModalProps> = ({
  group,
  result,
  isDark,
  onClose,
  onConfirm,
}) => {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const accountMap = useMemo(() => new Map<number, string>(
    [...result.accountInfo.entries()].map(([externalId, info]) => [externalId, info.accountId]),
  ), [result.accountInfo]);

  const options = useMemo(() => buildManualLinkOptions(
    group,
    accountMap,
    result.availableTradesByAccount,
  ).slice(0, 20), [group, accountMap, result.availableTradesByAccount]);

  const selected = options.find(option => option.key === selectedKey) || null;
  const infoFor = (externalId: number): ImportAccountInfo | undefined => result.accountInfo.get(externalId);

  const confirm = async () => {
    if (!selected || saving) return;
    setSaving(true);
    try {
      await onConfirm(selected);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[120] bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="manual-link-title"
        onMouseDown={event => event.stopPropagation()}
        className={`w-full max-w-3xl max-h-[88vh] overflow-hidden rounded-3xl border shadow-2xl flex flex-col ${
          isDark ? 'bg-slate-950 border-white/10 text-white' : 'bg-white border-slate-200 text-slate-900'
        }`}
      >
        <header className="flex items-start justify-between gap-4 px-6 py-5 border-b border-[var(--border-subtle)]">
          <div>
            <div className="flex items-center gap-2 text-blue-500 mb-1">
              <Link2 size={16} />
              <span className="text-[9px] font-black uppercase tracking-[0.18em]">Ruční propojení 1:1</span>
            </div>
            <h3 id="manual-link-title" className="text-lg font-black">
              {group.sample.symbol} · {new Date(group.sample.entry_at).toLocaleString('cs-CZ')}
            </h3>
            <p className="mt-1 text-[10px] text-[var(--text-secondary)]">
              Vyber existující validní obchod. Každá kopie se propojí pouze s obchodem na svém účtu.
            </p>
          </div>
          <button onClick={onClose} disabled={saving} aria-label="Zavřít" className="p-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/10 transition-colors">
            <X size={18} />
          </button>
        </header>

        <div className="overflow-y-auto px-6 py-5 space-y-4">
          {options.length === 0 ? (
            <div className="rounded-2xl border border-amber-500/25 bg-amber-500/5 p-5 flex gap-3">
              <AlertTriangle className="text-amber-500 shrink-0" size={18} />
              <div>
                <p className="text-sm font-black">Není tu volný validní obchod</p>
                <p className="text-[10px] text-[var(--text-secondary)] mt-1">
                  Buď na těchto účtech žádný validní obchod za načtené období není, nebo už je propojený či rezervovaný jinou exekucí.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-[9px] font-black uppercase tracking-widest text-[var(--text-muted)]">Existující obchody</p>
              {options.map(option => {
                const active = option.key === selectedKey;
                const representative = option.representative;
                const complete = option.coverage === option.totalExecutions;
                const candidatePnl = option.trades.reduce((sum, trade) => sum + trade.pnl, 0);
                return (
                  <button
                    key={option.key}
                    onClick={() => setSelectedKey(option.key)}
                    className={`w-full rounded-2xl border p-4 text-left transition-all ${
                      active
                        ? 'border-blue-500 bg-blue-500/10 ring-2 ring-blue-500/15'
                        : 'border-[var(--border-subtle)] hover:border-blue-500/40'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-black">{fmtDateTime(tradeTime(representative))}</span>
                          <span className="text-[9px] font-bold text-[var(--text-secondary)]">
                            {representative.instrument || '—'} · {representative.direction || '—'}
                          </span>
                          {normalizeSymbol(representative.instrument) === normalizeSymbol(group.sample.symbol) && (
                            <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500 text-[8px] font-black uppercase">stejný trh</span>
                          )}
                        </div>
                        <div className="mt-1 text-[9px] text-[var(--text-secondary)]">
                          {complete ? `Všech ${option.coverage} účtů` : `${option.coverage} z ${option.totalExecutions} účtů`}
                          {' · '}deník {fmtMoney(candidatePnl)}
                        </div>
                      </div>
                      <div className={`w-5 h-5 rounded-full border flex items-center justify-center shrink-0 ${active ? 'bg-blue-500 border-blue-500 text-white' : 'border-slate-300'}`}>
                        {active && <Check size={12} strokeWidth={3} />}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {selected && (
            <section className="rounded-2xl border border-[var(--border-subtle)] overflow-hidden">
              <div className="px-4 py-3 text-[9px] font-black uppercase tracking-widest text-[var(--text-muted)] bg-black/[0.025] dark:bg-white/[0.025]">
                Co se propojí
              </div>
              <div className="divide-y divide-[var(--border-subtle)]">
                {selected.pairs.map(({ execution, trade }) => (
                  <div key={execution.id} className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-4 py-3 text-[10px]">
                    <div className="min-w-0">
                      <div className="font-black truncate">{infoFor(execution.account_ext_id)?.name || execution.account_name || execution.account_ext_id}</div>
                      <div className={execution.pnl >= 0 ? 'text-emerald-500 font-bold' : 'text-rose-500 font-bold'}>{fmtMoney(execution.pnl)} import</div>
                    </div>
                    <Link2 size={13} className="text-blue-500" />
                    <div className="text-right min-w-0">
                      <div className="font-black truncate">{trade.instrument || 'Obchod v deníku'}</div>
                      <div className={trade.pnl >= 0 ? 'text-emerald-500 font-bold' : 'text-rose-500 font-bold'}>{fmtMoney(trade.pnl)} původně</div>
                    </div>
                  </div>
                ))}
              </div>
              {selected.coverage < selected.totalExecutions && (
                <p className="px-4 py-3 text-[9px] font-bold text-amber-500 bg-amber-500/5">
                  {selected.totalExecutions - selected.coverage} kopie nemá odpovídající volný obchod na svém účtu a zůstane ve frontě.
                </p>
              )}
            </section>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 px-6 py-4 border-t border-[var(--border-subtle)]">
          <p className="text-[9px] text-[var(--text-muted)]">Databáze nedovolí použít jeden obchod dvakrát.</p>
          <button
            onClick={confirm}
            disabled={!selected || saving}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-[9px] font-black uppercase tracking-widest transition-all"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />}
            {selected ? `Propojit ${selected.coverage} ${selected.coverage === 1 ? 'exekuci' : 'exekucí'}` : 'Vyber obchod'}
          </button>
        </footer>
      </div>
    </div>
  );
};

export default ImportManualLinkModal;
