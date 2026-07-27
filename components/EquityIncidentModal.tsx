import React from 'react';
import { AlertTriangle, Lightbulb, Target, X } from 'lucide-react';
import type { EquityPoint, TradingIncident } from '../types';

interface EquityIncidentModalProps {
  point: EquityPoint;
  incident: TradingIncident;
  theme: 'dark' | 'light' | 'oled';
  onClose: () => void;
}

const TYPE_LABEL: Record<TradingIncident['type'], string> = {
  gambling: 'Gambling / impulzivní trading',
  platform_error: 'Chyba platformy',
  other: 'Jiný incident',
};

const EquityIncidentModal: React.FC<EquityIncidentModalProps> = ({ point, incident, theme, onClose }) => {
  const isDark = theme !== 'light';
  const event = point.event!;
  const date = new Date(`${String(point.date).slice(0, 10)}T12:00:00`);
  const dateLabel = Number.isNaN(date.getTime())
    ? point.date
    : date.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/65 p-4 backdrop-blur-md" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Detail incidentu"
        onClick={e => e.stopPropagation()}
        className={`w-full max-w-xl overflow-hidden rounded-[30px] border shadow-2xl ${isDark ? 'border-white/10 bg-[var(--bg-card)] text-white' : 'border-slate-200 bg-white text-slate-900'}`}
      >
        <div className={`flex items-center gap-3 border-b px-6 py-5 ${isDark ? 'border-white/10' : 'border-slate-100'}`}>
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-rose-500/25 bg-rose-500/10 text-rose-500">
            <AlertTriangle size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[9px] font-black uppercase tracking-[0.18em] text-rose-500">Incident na equity křivce</p>
            <h3 className="truncate text-lg font-black">{incident.title}</h3>
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{dateLabel} · {TYPE_LABEL[incident.type]}</p>
          </div>
          <button onClick={onClose} aria-label="Zavřít incident" className="rounded-xl p-2 text-slate-500 transition-colors hover:bg-rose-500/10 hover:text-rose-500">
            <X size={20} />
          </button>
        </div>

        <div className="space-y-4 p-6">
          <div className={`flex items-center justify-between rounded-2xl border px-4 py-3 ${isDark ? 'border-rose-500/20 bg-rose-500/5' : 'border-rose-200 bg-rose-50'}`}>
            <div>
              <p className="text-[9px] font-black uppercase tracking-widest text-slate-500">Dopad na {event.label}</p>
              <p className="mt-1 font-mono text-2xl font-black text-rose-500">−${Math.abs(event.amount).toLocaleString()}</p>
            </div>
            <div className="text-right">
              <p className="text-[9px] font-black uppercase tracking-widest text-slate-500">Celý incident</p>
              <p className="mt-1 font-mono text-sm font-black text-rose-400">
                −${incident.allocations.reduce((sum, item) => sum + Math.abs(Number(item.lossAmount) || 0), 0).toLocaleString()}
              </p>
            </div>
          </div>

          <section>
            <p className="mb-1.5 text-[9px] font-black uppercase tracking-widest text-slate-500">Co se stalo</p>
            <p className={`rounded-2xl border px-4 py-3 text-sm font-semibold leading-relaxed ${isDark ? 'border-white/10 bg-white/[0.03] text-slate-200' : 'border-slate-100 bg-slate-50 text-slate-700'}`}>
              {incident.whatHappened || 'Bez popisu.'}
            </p>
          </section>

          {incident.trigger && (
            <section className="flex gap-3 rounded-2xl border border-orange-500/20 bg-orange-500/5 px-4 py-3">
              <Target size={16} className="mt-0.5 shrink-0 text-orange-500" />
              <div>
                <p className="text-[9px] font-black uppercase tracking-widest text-orange-500">Spouštěč</p>
                <p className="mt-1 text-xs font-semibold leading-relaxed text-slate-500">{incident.trigger}</p>
              </div>
            </section>
          )}

          {incident.lesson && (
            <section className="flex gap-3 rounded-2xl border border-amber-500/20 bg-amber-500/5 px-4 py-3">
              <Lightbulb size={16} className="mt-0.5 shrink-0 text-amber-500" />
              <div>
                <p className="text-[9px] font-black uppercase tracking-widest text-amber-500">Klíčová lekce</p>
                <p className="mt-1 text-xs font-semibold leading-relaxed text-slate-500">{incident.lesson}</p>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
};

export default EquityIncidentModal;
