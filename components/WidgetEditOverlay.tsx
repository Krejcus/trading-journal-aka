import React from 'react';
import { Trash2, ShieldCheck } from 'lucide-react';

interface WidgetEditOverlayProps {
  id: string;
  label?: string;
  showDisciplinedCurve?: boolean;
  onRemove: () => void;
  onToggleDisciplinedCurve?: () => void;
}

const WidgetEditOverlay: React.FC<WidgetEditOverlayProps> = ({
  id,
  label,
  showDisciplinedCurve,
  onRemove,
  onToggleDisciplinedCurve,
}) => {
  return (
    <>
      {/* Floating toolbar - top right */}
      <div className="absolute top-2 right-2 z-[60] flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all pointer-events-none group-hover:pointer-events-auto">
        <div className="flex items-center gap-0.5 bg-slate-900/95 dark:bg-slate-800/95 backdrop-blur-xl rounded-full px-1.5 py-1 shadow-2xl border border-white/10">
          {id === 'equity' && onToggleDisciplinedCurve && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleDisciplinedCurve(); }}
              onMouseDown={(e) => e.stopPropagation()}
              className={`w-6 h-6 flex items-center justify-center rounded-full transition-all ${
                showDisciplinedCurve
                  ? 'bg-amber-500 text-white'
                  : 'text-slate-400 hover:text-amber-400 hover:bg-white/10'
              }`}
              title="Zlatá křivka"
            >
              <ShieldCheck size={12} />
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            onMouseDown={(e) => e.stopPropagation()}
            className="w-6 h-6 flex items-center justify-center rounded-full text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition-all"
            title="Odstranit"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {/* Label badge */}
      <div className="absolute -top-2.5 left-3 z-50 bg-indigo-500/90 text-white text-[8px] font-black px-2.5 py-0.5 rounded-full uppercase tracking-widest opacity-0 group-hover:opacity-100 transition-opacity shadow-lg pointer-events-none">
        {label}
      </div>

      {/* Edit ring */}
      <div className="absolute inset-0 rounded-[24px] ring-1 ring-indigo-500/20 group-hover:ring-2 group-hover:ring-indigo-500/40 transition-all pointer-events-none z-20" />
    </>
  );
};

export default WidgetEditOverlay;
